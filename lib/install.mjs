import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AVAILABILITY_FILE, CONFIG_FILE, canonicalProvider, inferProvider, isAllowlist, isObject, isStringList, isV2,
  normalizeModel, normalizeName, readJson,
} from '../hooks/_shared.mjs';
import { MANIFEST_FILE, fileHash, hashOf, readManifest, writeManifest } from './manifest.mjs';
import { removeMirrors, syncMirrors } from './mirrors.mjs';
import { CliError, PACKAGE_ROOT, safePath } from './paths.mjs';
import { CATALOG, PROVIDERS, resolveTiers, toConfig } from './plans.mjs';
import { summaryTable } from './prompt.mjs';
import { LADDERS, renderSkill } from './render.mjs';
import { HOOKS, HOOKS_DIR, hookCommand, mergeSettings, readSettings, taggedHooks, unmergeSettings, writeSettings } from './settings.mjs';

export const PRESETS = ['tri-provider', 'claude-codex', 'claude-only'];
const EFFORTS = ['low', 'medium', 'high'];
const SKILL = 'skills/auto-build/SKILL.md';
const CORE_FILES = ['CLAUDE.md', 'rules/code-quality.md', 'commands/fix.md', 'commands/review.md', 'commands/handover.md'];
const HOOK_FILES = ['_shared.mjs', '_quota.mjs', ...HOOKS.map((hook) => hook.script)].map((name) => `${HOOKS_DIR}/${name}`);

export const wantsCore = (modules) => modules !== 'auto-build';
export const wantsAuto = (modules) => modules !== 'core';

/** Every file a module selection owns, relative to the target. */
export const moduleFiles = (modules) => [
  ...(wantsCore(modules) ? CORE_FILES : []),
  ...(wantsAuto(modules) ? [SKILL, ...HOOK_FILES, CONFIG_FILE] : []),
];

export const loadPreset = (name) => readJson(path.join(PACKAGE_ROOT, 'presets', `${name}.json`));
const union = (a, b) => [...new Map([...a, ...b].map((item) => [item.toLowerCase(), item])).values()];

const SHARING = ['provider', 'heavy-tier-only'];
const optional = (value, valid) => value === undefined || valid(value);
const isTier = (tier) => isObject(tier)
  && optional(tier.plan, (v) => typeof v === 'string')
  && optional(tier.sharing, (v) => SHARING.includes(v))
  && optional(tier.resetDay, (v) => typeof v === 'string' || Number.isInteger(v))
  && optional(tier.heavyModels, isStringList);

export function configProblem(config) {
  if (!isAllowlist(config.allowlist)) return '"allowlist" must map provider names to lists of model names';
  if (!isStringList(config.bannedModels)) return '"bannedModels" must be a list of model names';
  if (!isObject(config.ladders) || !Object.values(config.ladders).every(isStringList)) return '"ladders" must map ladder names to lists';
  const percent = config.compactionThreshold;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return '"compactionThreshold" must be an integer from 1 to 100';
  if (!EFFORTS.includes(config.defaultEffort)) return `"defaultEffort" must be one of ${EFFORTS.join(', ')}`;
  if (typeof config.defaultModel !== 'string') return '"defaultModel" must be a model name';
  if (!optional(config.tiers, (v) => isObject(v) && Object.values(v).every(isTier))) {
    return `"tiers" must map provider names to settings (sharing: ${SHARING.join(' or ')}; heavyModels: list of model names)`;
  }
  if (!optional(config.modelIds, (v) => isObject(v) && isStringList(Object.values(v)))) {
    return '"modelIds" must map model names to CLI model ids';
  }
  return null;
}

/** The config with missing fields filled from its preset. */
export function completeConfig(config) {
  const preset = loadPreset(PRESETS.includes(config.preset) ? config.preset : PRESETS[0]);
  const ladders = config.ladders === undefined
    ? { ...preset.ladders }
    : isObject(config.ladders) ? { ...preset.ladders, ...config.ladders } : config.ladders;
  return { ...preset, ...config, ladders };
}

/** What a v1 install is assumed to pay for: a low paid tier with a CLI. */
export const ASSUMED_TIERS = { claude: 'pro', codex: 'plus', antigravity: 'plus' };
const OLD_DEFAULT_BANS = ['argon', 'fable/mythos'];

function inferSubscriptions(config) {
  const present = new Set(Object.entries(config.allowlist)
    .filter(([, models]) => models.length > 0)
    .map(([name]) => canonicalProvider(name)));
  return Object.fromEntries(PROVIDERS.map((p) => [p, present.has(p) ? ASSUMED_TIERS[p] : 'none']));
}

/** The subscription selection to resolve, or null to keep the config as it is. Flags > prompts > existing config. */
function tierRequest(existing, options) {
  const v2 = isV2(existing);
  const flags = Object.fromEntries(PROVIDERS.map((p) => [p, options[`${p}Tier`]]));
  const prompted = Object.values(options.subscriptions ?? {});
  const wanted = Object.values(flags).some((tier) => tier !== undefined)
    || (v2 ? prompted.length > 0 || Boolean(options.parent) || options.allowUsageCredits !== undefined
      : prompted.some((tier) => tier !== 'none'));
  if (!wanted) {
    if (options.parent) throw new CliError('--parent needs a subscription tier (--claude-tier)', 2);
    return null;
  }
  const base = v2 ? existing.subscriptions : existing && inferSubscriptions(completeConfig(existing));
  return {
    subscriptions: Object.fromEntries(PROVIDERS.map(
      (p) => [p, flags[p] ?? options.subscriptions?.[p] ?? base?.[p] ?? 'none'],
    )),
    allowUsageCredits: options.allowUsageCredits ?? existing?.allowUsageCredits ?? false,
    parent: options.parent ?? undefined,
  };
}

function resolve(subscriptions, settings) {
  try {
    return resolveTiers(subscriptions, settings);
  } catch (error) {
    throw new CliError(error.message, 2);
  }
}

const userBans = (config) => (isV2(config)
  ? union(config.userBannedModels ?? [], config.bannedModels ?? [])
  : (config?.bannedModels ?? []).filter((entry) => !OLD_DEFAULT_BANS.includes(entry.trim().toLowerCase())));

/** A v2 config for the request. An unchanged selection keeps the existing ladders and models. */
function subscriptionConfig(existing, { subscriptions, allowUsageCredits, parent }) {
  const claude = CATALOG.claude[subscriptions.claude];
  const previous = existing?.parent?.model;
  const keepParent = claude?.parentOptions?.includes(previous) && (!claude.usageBilled || allowUsageCredits);
  const resolved = resolve(subscriptions, { parent: parent ?? (keepParent ? previous : undefined), allowUsageCredits });
  if (isV2(existing) && isDeepStrictEqual(subscriptions, existing.subscriptions)
    && allowUsageCredits === (existing.allowUsageCredits ?? false)) {
    return { ...existing, ...(parent && parent !== previous && { parent: resolved.parent }) };
  }
  const config = toConfig(resolved, {
    allowUsageCredits,
    allowFastModes: existing?.allowFastModes,
    verifiedOrg: existing?.verifiedOrg,
    userBannedModels: userBans(existing),
    compactionThreshold: existing?.compactionThreshold,
  });
  for (const key of ['defaultEffort', 'modelIds', 'discovery']) {
    if (existing?.[key] !== undefined) config[key] = existing[key];
  }
  return config;
}

/** Existing user config is the base; explicit flags override it. */
function planConfig(file, options) {
  let existing = null;
  let invalid = false;
  if (fs.existsSync(file)) {
    try {
      existing = readJson(file);
      invalid = !isObject(existing) || configProblem(completeConfig(existing)) !== null;
    } catch {
      invalid = true;
    }
    if (invalid && !options.force) {
      const reason = isObject(existing) ? configProblem(completeConfig(existing)) : 'not a JSON object';
      throw new CliError(`${file}: ${reason}. Fix it, or use --force to back it up and replace it`);
    }
    if (invalid) existing = null;
  }

  const request = tierRequest(existing, options);
  let config = request ? subscriptionConfig(existing, request)
    : existing ? { ...existing } : loadPreset(options.preset ?? PRESETS[0]);
  // A rebuilt roster replaces the user's ladders, so it is always backed up.
  const rebuilt = Boolean(request && existing) && !isDeepStrictEqual(config.ladders, existing.ladders);
  if (!isV2(config) && existing && options.preset && options.preset !== existing.preset) {
    const preset = loadPreset(options.preset);
    config = {
      ...preset,
      ...existing,
      preset: preset.preset,
      allowlist: preset.allowlist,
      ladders: preset.ladders,
      defaultModel: preset.defaultModel,
      defaultEffort: preset.defaultEffort,
      bannedModels: union(existing.bannedModels ?? [], preset.bannedModels),
    };
  }
  if (options.compaction !== undefined) config.compactionThreshold = options.compaction;
  if (options.banned?.length) {
    config.bannedModels = union(completeConfig(config).bannedModels, options.banned);
    if (isV2(config)) config.userBannedModels = union(config.userBannedModels ?? [], options.banned);
  }
  if (isV2(config)) {
    for (const key of ['allowFastModes', 'verifiedOrg']) if (options[key] !== undefined) config[key] = options[key];
  }
  for (const [name, tier] of Object.entries(isV2(config) ? {} : options.tiers ?? {})) {
    const old = config.tiers?.[name];
    config.tiers = { ...config.tiers, [name]: { ...old, ...tier, heavyModels: old?.heavyModels ?? tier.heavyModels } };
  }

  const complete = completeConfig(config);
  const problem = configProblem(complete);
  if (problem) throw new CliError(`${file}: ${problem}`);
  const changed = !existing || !isDeepStrictEqual(config, existing);
  const text = changed ? `${JSON.stringify(config, null, 2)}\n` : null;
  return { complete, invalid, rebuilt, selected: Boolean(request), text };
}

/** First of <file>.bak, .bak.1, ... that is free or already holds this content, so no backup is lost. */
function backUp(file) {
  const content = fs.readFileSync(file);
  for (let i = 0; ; i += 1) {
    const backup = `${file}.bak${i ? `.${i}` : ''}`;
    if (fs.existsSync(backup) && !fs.readFileSync(backup).equals(content)) continue;
    fs.writeFileSync(backup, content);
    return backup;
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFile(temp, content);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Writes managed files, keeping the user's edits unless forced. Updates the hashes in "files". */
export function writeManaged(target, desired, files, { force = false, log = console.log } = {}) {
  for (const [relative, content] of desired) {
    const file = safePath(target, relative);
    if (!file) {
      log(`warning: skipped ${relative} (symlink in its path)`);
      continue;
    }
    if (fs.existsSync(file)) {
      const current = fileHash(file);
      if (current === hashOf(content)) {
        if (files[relative]) files[relative] = current;
        continue;
      }
      if (current !== files[relative]) {
        if (!force) {
          log(`warning: skipped ${relative} (existing file with your changes; --force backs it up and overwrites)`);
          continue;
        }
        log(`backed up: ${backUp(file)}`);
      }
    }
    writeFile(file, content);
    files[relative] = hashOf(content);
    log(`installed: ${relative}`);
  }
}

/** A config you edited stays "yours": it keeps the old hash, so uninstall will not delete it. */
function writeConfig(file, text, files, { invalid = false, alwaysBackUp = false, log }) {
  const exists = fs.existsSync(file);
  const ours = !exists || invalid || files[CONFIG_FILE] === fileHash(file);
  const backup = exists && (alwaysBackUp || invalid || !ours) ? backUp(file) : null;
  if (backup) log(`backed up: ${backup}`);
  writeAtomic(file, text);
  if (ours) files[CONFIG_FILE] = hashOf(text);
  log(`wrote: ${CONFIG_FILE}`);
  return backup;
}

const renderInstalledSkill = (config, target) => Buffer.from(renderSkill(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'skills', 'auto-build', 'SKILL.md.tmpl'), 'utf8'), config, target,
));

/** Persists a changed config into an existing installation and re-renders SKILL.md. Nothing else is touched. */
export async function syncConfig(target, config, { force = false, log = console.log } = {}) {
  const manifest = readManifest(target);
  if (!manifest || !wantsAuto(manifest.modules)) {
    throw new CliError(`no auto-build installation in ${target}; run init first`);
  }
  const complete = isObject(config) ? completeConfig(config) : null;
  const problem = complete ? configProblem(complete) : 'not a JSON object';
  if (problem) throw new CliError(`${CONFIG_FILE}: ${problem}`);
  const configPath = safePath(target, CONFIG_FILE);
  if (!configPath) throw new CliError(`${path.join(target, CONFIG_FILE)} is a symlink; refusing to manage it`);
  const skill = renderInstalledSkill(complete, target); // renders before the first write

  const files = { ...manifest.files };
  let current;
  try {
    current = readJson(configPath);
  } catch {
    current = undefined;
  }
  if (!isDeepStrictEqual(current, config)) {
    writeConfig(configPath, `${JSON.stringify(config, null, 2)}\n`, files, { alwaysBackUp: true, log });
  }
  writeManaged(target, new Map([[SKILL, skill]]), files, { force, log });
  const skillMirrors = syncMirrors(target, skill, {
    skillTargets: manifest.skillTargets ?? 'auto',
    existingMirrors: manifest.skillMirrors,
    force,
    log,
  });
  writeManifest(target, { ...manifest, files, skillMirrors });
}

/** Delete managed files that are still exactly as installed. Returns the entries that were kept. */
function removeManaged(target, entries, log) {
  const kept = {};
  for (const [relative, hash] of entries) {
    const file = safePath(target, relative);
    if (!file) {
      log(`warning: ignored unsafe manifest path ${JSON.stringify(relative)}`);
      continue;
    }
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile() || fileHash(file) !== hash) {
      kept[relative] = hash;
      log(`kept (modified since install): ${relative}`);
      continue;
    }
    fs.rmSync(file);
    log(`removed: ${relative}`);
    for (let dir = path.dirname(file); dir !== path.resolve(target); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch {
        break;
      }
    }
  }
  return kept;
}

/** Contents of every managed file of a module selection, except the config. */
function desiredFiles(target, modules, config) {
  const desired = new Map();
  const source = (...parts) => fs.readFileSync(path.join(PACKAGE_ROOT, ...parts));
  if (wantsCore(modules)) for (const file of CORE_FILES) desired.set(file, source('core', file));
  if (wantsAuto(modules)) {
    desired.set(SKILL, renderInstalledSkill(config, target));
    for (const file of HOOK_FILES) {
      if (!safePath(target, file)) throw new CliError(`${file} goes through a symlink; refusing to install hooks there`);
      desired.set(file, source('hooks', path.posix.basename(file)));
    }
  }
  return desired;
}

/** Writes the planned settings.json, warning when a hand-set compaction value is replaced. */
function applySettings(settings, merged, manifest, log) {
  const next = merged ? merged.data : unmergeSettings(settings.data, manifest.env);
  const previous = manifest?.env?.installed;
  const current = settings.data.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (merged && previous !== undefined && current !== undefined && current !== previous && current !== merged.env.installed) {
    log('warning: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE was changed by hand; replaced with the configured value');
  }
  if (writeSettings(settings, next)) log('updated: settings.json');
}

export function install(target, options, log = console.log) {
  const manifest = readManifest(target);
  const modules = options.modules ?? manifest?.modules ?? 'full';
  const auto = wantsAuto(modules);
  const tierOptions = ['claudeTier', 'codexTier', 'antigravityTier', 'parent'].some((key) => options[key]);
  if (!auto && (options.preset || options.compaction !== undefined || options.banned?.length || options.tiers || tierOptions)) {
    log('warning: preset, compaction, banned models and tiers do not apply to the core module; ignored');
  }

  // Plan and validate everything before the first write.
  if (auto) HOOKS.forEach((hook) => hookCommand(target, hook.script));
  // settings.json is only opened when we wire hooks now, or have to unwire an earlier install.
  const unwire = !auto && manifest !== null && (manifest.env !== undefined || wantsAuto(manifest.modules));
  const settings = auto || unwire ? readSettings(target) : null;
  const configPath = path.join(target, CONFIG_FILE);
  if (auto && fs.existsSync(configPath) && !safePath(target, CONFIG_FILE)) {
    throw new CliError(`${configPath} is a symlink; refusing to manage it`);
  }
  const config = auto ? planConfig(configPath, options) : null;

  const desired = desiredFiles(target, modules, config?.complete);
  const v2 = auto && isV2(config.complete);
  const merged = auto
    ? mergeSettings(settings.data, target, config.complete.compactionThreshold, manifest?.env, v2 ? config.complete.parent : undefined)
    : null;
  if (v2) {
    if (options.preset && options.preset !== config.complete.preset) {
      log('warning: --preset does not apply to a v2 config; subscription tiers decide the providers');
    }
    if (options.tiers) log('warning: --tiers does not apply to a v2 config; use --claude-tier, --codex-tier, --antigravity-tier');
    if (config.selected) log(summaryTable(config.complete));
  } else if (auto && (options.allowFastModes || options.verifiedOrg || options.allowUsageCredits)) {
    log('warning: fast modes, verified org and usage credits need a subscription tier; ignored');
  }

  fs.mkdirSync(target, { recursive: true });
  const files = { ...manifest?.files };
  const skillTargets = options.skillTargets ?? manifest?.skillTargets ?? 'auto';
  let skillMirrors = { ...manifest?.skillMirrors };

  writeManaged(target, desired, files, { force: options.force, log });
  if (auto) {
    skillMirrors = syncMirrors(target, desired.get(SKILL), {
      skillTargets, existingMirrors: skillMirrors, force: options.force, log,
    });
  } else if (Object.keys(skillMirrors).length > 0) {
    skillMirrors = removeMirrors(skillMirrors, log);
  }

  if (config?.text) {
    writeConfig(configPath, config.text, files, { invalid: config.invalid, alwaysBackUp: config.rebuilt, log });
  }

  const record = () => writeManifest(target, {
    version: 1, modules, files, ...(merged && { env: merged.env }), skillTargets, skillMirrors,
  });
  // Wiring: put the prior env value on record before settings.json changes.
  if (merged) record();

  if (settings) applySettings(settings, merged, manifest, log);

  // Stale files go after settings.json, so hooks never point at deleted scripts.
  const owned = new Set(moduleFiles(modules));
  const stale = Object.entries(files).filter(([relative]) => !owned.has(relative));
  const kept = removeManaged(target, stale, log);
  for (const [relative] of stale) if (!(relative in kept)) delete files[relative];
  record();
  log(`done: ${modules} installed in ${target}`);
  if (auto) log('Restart T3 Code (and any running Claude Code session) so hooks and settings load.');
}

/** v1 ladder slots keep roster models (as canonical ids); the rest are filled from the resolved ladder. */
function migrateLadders(old, { models, ladders }) {
  const key = (name) => normalizeName(normalizeModel(name.trim()));
  const base = (entry) => entry.split('@')[0];
  const canonical = (entry) => {
    const [ref, effort] = entry.split('@');
    const colon = ref.indexOf(':');
    const provider = colon < 0 ? null : canonicalProvider(ref.slice(0, colon));
    const found = models.find((m) => key(m.model) === key(ref.slice(colon + 1))
      && m.provider === (colon < 0 ? inferProvider(m.model) : provider));
    if (!found) return null;
    const id = found.provider === inferProvider(found.model) ? found.model : `${found.provider}:${found.model}`;
    return effort ? `${id}@${effort.trim()}` : id;
  };
  return Object.fromEntries(LADDERS.map((name) => {
    const kept = (old?.[name] ?? []).map(canonical);
    if (!kept.some(Boolean)) return [name, ladders[name]];
    const used = new Set(kept.filter(Boolean).map(base));
    const spare = ladders[name].filter((entry) => !used.has(base(entry)));
    return [name, kept.map((entry) => entry ?? spare.shift()).filter(Boolean)];
  }));
}

/** Converts a v1 config to schema 2: backup, atomic write, then re-render of the files the manifest owns. */
export function upgrade(target, { log = console.log } = {}) {
  const manifest = readManifest(target);
  const file = path.join(target, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new CliError(`${file}: nothing to upgrade; run t3-auto-build init`);
  if (!safePath(target, CONFIG_FILE)) throw new CliError(`${file} is a symlink; refusing to manage it`);
  let existing;
  try {
    existing = readJson(file);
  } catch {
    throw new CliError(`${file}: not valid JSON; fix it, then run upgrade again`);
  }
  if (!isObject(existing)) throw new CliError(`${file}: not a JSON object`);
  if (isV2(existing)) {
    log(`${CONFIG_FILE} is already schema version 2; nothing to do`);
    return { upgraded: false, backup: null, config: existing };
  }
  if (existing.schemaVersion !== undefined) {
    throw new CliError(`${file}: unknown schemaVersion ${JSON.stringify(existing.schemaVersion)}; not upgrading`);
  }
  const old = completeConfig(existing);
  const problem = configProblem(old);
  if (problem) throw new CliError(`${file}: ${problem}`);

  const resolved = resolve(inferSubscriptions(old));
  const config = toConfig(resolved, { userBannedModels: userBans(existing), compactionThreshold: old.compactionThreshold });
  config.ladders = migrateLadders(existing.ladders, resolved);
  config.defaultEffort = old.defaultEffort;
  for (const key of ['modelIds', 'discovery']) if (existing[key] !== undefined) config[key] = existing[key];

  // Plan and validate everything before the first write.
  const auto = manifest !== null && wantsAuto(manifest.modules);
  if (auto) HOOKS.forEach((hook) => hookCommand(target, hook.script));
  const settings = auto ? readSettings(target) : null;
  renderInstalledSkill(config, target);
  const desired = new Map(manifest
    ? [...desiredFiles(target, manifest.modules, config)].filter(([relative]) => Object.hasOwn(manifest.files, relative))
    : []);
  const merged = auto
    ? mergeSettings(settings.data, target, config.compactionThreshold, manifest.env, config.parent)
    : null;

  log(summaryTable(config));
  log('note: tiers are assumed from your v1 providers; run init with --claude-tier, --codex-tier, --antigravity-tier to set yours');
  const files = { ...manifest?.files };
  const backup = writeConfig(file, `${JSON.stringify(config, null, 2)}\n`, files, { alwaysBackUp: true, log });
  writeManaged(target, desired, files, { log });
  const skillMirrors = auto
    ? syncMirrors(target, renderInstalledSkill(config, target), {
      skillTargets: manifest.skillTargets ?? 'auto', existingMirrors: manifest.skillMirrors, log,
    })
    : manifest?.skillMirrors;
  // As in install: the prior settings values are on record before settings.json changes.
  if (manifest) writeManifest(target, { ...manifest, files, ...(merged && { env: merged.env }), skillMirrors });
  if (merged) {
    applySettings(settings, merged, manifest, log);
    log('Restart T3 Code (and any running Claude Code session) so hooks and settings load.');
  }
  return { upgraded: true, backup, config };
}

export function uninstall(target, log = console.log) {
  const manifest = readManifest(target);
  const settingsExists = fs.existsSync(path.join(target, 'settings.json'));
  const touchesSettings = manifest ? manifest.env !== undefined || wantsAuto(manifest.modules) : settingsExists;
  const settings = touchesSettings ? readSettings(target) : null;

  // Unwire before deleting, so a failure never leaves hooks pointing at missing files.
  if (settings && (manifest || taggedHooks(settings.data).length)) {
    if (writeSettings(settings, unmergeSettings(settings.data, manifest?.env))) log('updated: settings.json');
  }
  if (!manifest) {
    log(`nothing to uninstall: no ${MANIFEST_FILE} in ${target}`);
    return;
  }
  removeManaged(target, Object.entries(manifest.files), log);
  if (manifest.skillMirrors) removeMirrors(manifest.skillMirrors, log);
  // A generated cache, never listed in the manifest.
  const cache = safePath(target, AVAILABILITY_FILE);
  if (cache && fs.existsSync(cache) && fs.statSync(cache).isFile()) {
    fs.rmSync(cache);
    log(`removed: ${AVAILABILITY_FILE}`);
  }
  fs.rmSync(path.join(target, MANIFEST_FILE));
  log(`done: uninstalled from ${target}`);
}

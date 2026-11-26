import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONFIG_FILE, isAllowlist, isObject, isStringList, readJson } from '../hooks/_shared.mjs';
import { MANIFEST_FILE, fileHash, hashOf, readManifest, writeManifest } from './manifest.mjs';
import { CliError, PACKAGE_ROOT, safePath } from './paths.mjs';
import { renderSkill } from './render.mjs';
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
  return { ...preset, ...config, ladders: isObject(config.ladders ?? {}) ? { ...preset.ladders, ...config.ladders } : config.ladders };
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

  let config = existing ? { ...existing } : loadPreset(options.preset ?? PRESETS[0]);
  if (existing && options.preset && options.preset !== existing.preset) {
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
  if (options.banned?.length) config.bannedModels = union(completeConfig(config).bannedModels, options.banned);
  for (const [name, tier] of Object.entries(options.tiers ?? {})) {
    const old = config.tiers?.[name];
    config.tiers = { ...config.tiers, [name]: { ...old, ...tier, heavyModels: old?.heavyModels ?? tier.heavyModels } };
  }

  const complete = completeConfig(config);
  const problem = configProblem(complete);
  if (problem) throw new CliError(`${file}: ${problem}`);
  const changed = !existing || !isDeepStrictEqual(config, existing);
  return { complete, invalid, text: changed ? `${JSON.stringify(config, null, 2)}\n` : null };
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
  if (exists && (alwaysBackUp || invalid || !ours)) log(`backed up: ${backUp(file)}`);
  writeFile(file, text);
  if (ours) files[CONFIG_FILE] = hashOf(text);
  log(`wrote: ${CONFIG_FILE}`);
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
  writeManifest(target, { ...manifest, files });
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

export function install(target, options, log = console.log) {
  const manifest = readManifest(target);
  const modules = options.modules ?? manifest?.modules ?? 'full';
  const auto = wantsAuto(modules);
  if (!auto && (options.preset || options.compaction !== undefined || options.banned?.length || options.tiers)) {
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

  const desired = new Map();
  const source = (...parts) => fs.readFileSync(path.join(PACKAGE_ROOT, ...parts));
  if (wantsCore(modules)) for (const file of CORE_FILES) desired.set(file, source('core', file));
  if (auto) {
    desired.set(SKILL, renderInstalledSkill(config.complete, target));
    for (const file of HOOK_FILES) {
      if (!safePath(target, file)) throw new CliError(`${file} goes through a symlink; refusing to install hooks there`);
      desired.set(file, source('hooks', path.posix.basename(file)));
    }
  }
  const merged = auto ? mergeSettings(settings.data, target, config.complete.compactionThreshold, manifest?.env) : null;

  fs.mkdirSync(target, { recursive: true });
  const files = { ...manifest?.files };

  writeManaged(target, desired, files, { force: options.force, log });

  if (config?.text) writeConfig(configPath, config.text, files, { invalid: config.invalid, log });

  const record = () => writeManifest(target, { version: 1, modules, files, ...(merged && { env: merged.env }) });
  // Wiring: put the prior env value on record before settings.json changes.
  if (merged) record();

  if (settings) {
    const next = merged ? merged.data : unmergeSettings(settings.data, manifest.env);
    const previous = manifest?.env?.installed;
    const current = settings.data.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (merged && previous !== undefined && current !== undefined && current !== previous && current !== merged.env.installed) {
      log('warning: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE was changed by hand; replaced with the configured value');
    }
    if (writeSettings(settings, next)) log('updated: settings.json');
  }

  // Stale files go after settings.json, so hooks never point at deleted scripts.
  const owned = new Set(moduleFiles(modules));
  const stale = Object.entries(files).filter(([relative]) => !owned.has(relative));
  const kept = removeManaged(target, stale, log);
  for (const [relative] of stale) if (!(relative in kept)) delete files[relative];
  record();
  log(`done: ${modules} installed in ${target}`);
  if (auto) log('Restart T3 Code (and any running Claude Code session) so hooks and settings load.');
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
  fs.rmSync(path.join(target, MANIFEST_FILE));
  log(`done: uninstalled from ${target}`);
}

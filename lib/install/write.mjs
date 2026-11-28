// Everything that writes into a target: backups, atomic writes, install, config sync and uninstall.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AVAILABILITY_FILE, CONFIG_FILE, QUOTA_FILE, RETIRED_MODELS, RUNTIME_SNAPSHOT_FILE, canonicalProvider, effectiveAllowlist,
  isObject, isStringList, isSupportedSchema, isV3, normalizeModel, normalizeName, readJson,
} from '../../hooks/_shared.mjs';
import { MANIFEST_FILE, fileHash, hashOf, readManifest, writeManifest } from '../manifest.mjs';
import { removeMirrors, syncMirrors } from '../mirrors.mjs';
import { CliError, PACKAGE_ROOT, PACKAGE_VERSION, safePath } from '../paths.mjs';
import { summaryTable } from '../prompt.mjs';
import { renderSkill } from '../render.mjs';
import {
  HOOKS, backUp, hookCommand, mergeSettings, readSettings, taggedHooks, unmergeSettings, writeSettings,
} from '../settings.mjs';
import {
  CORE_FILES, HOOK_FILES, SKILL, completeConfig, configProblem, moduleFiles, planConfig, union, wantsAuto, wantsCore,
} from './plan.mjs';

export { backUp };

/** Temp file + rename, keeping the mode of the file it replaces. */
export function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    if (mode !== undefined) fs.chmodSync(temp, mode);
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
        // --force takes ownership, so a lost manifest can be rebuilt; a plain run never claims a file it did not write.
        if (force || files[relative]) files[relative] = current;
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
    writeAtomic(file, content);
    files[relative] = hashOf(content);
    log(`installed: ${relative}`);
  }
}

/** A config you edited stays "yours": it keeps the old hash, so uninstall will not delete it. */
export function writeConfig(file, text, files, { invalid = false, alwaysBackUp = false, log }) {
  const exists = fs.existsSync(file);
  const ours = !exists || invalid || files[CONFIG_FILE] === fileHash(file);
  const backup = exists && (alwaysBackUp || invalid || !ours) ? backUp(file) : null;
  if (backup) log(`backed up: ${backup}`);
  writeAtomic(file, text);
  if (ours) files[CONFIG_FILE] = hashOf(text);
  log(`wrote: ${CONFIG_FILE}`);
  return backup;
}

/**
 * Writes the pre-flattened guard data the hooks fast-path load. "configHash" is the sha256 of the bytes of the
 * config file on disk, so a hook can tell a stale snapshot; write the config first.
 */
export function writeRuntimeSnapshot(target, config) {
  const complete = isObject(config) ? completeConfig(config) : null;
  const problem = complete ? configProblem(complete) : 'not a JSON object';
  if (problem) throw new CliError(`${CONFIG_FILE}: ${problem}`);
  const file = safePath(target, RUNTIME_SNAPSHOT_FILE);
  if (!file) throw new CliError(`${path.join(target, RUNTIME_SNAPSHOT_FILE)} is a symlink; refusing to manage it`);
  const list = (value) => (isStringList(value) ? value : []);
  const bannedModels = union(complete.bannedModels, list(complete.userBannedModels));
  const allowlistKeys = effectiveAllowlist({ ...complete, bannedModels }).flatMap(
    ([provider, models]) => models.map(
      (model) => `${canonicalProvider(provider) ?? provider.toLowerCase()}:${normalizeName(normalizeModel(model))}`,
    ),
  );
  const configPath = path.join(target, CONFIG_FILE);
  const text = `${JSON.stringify({
    schemaVersion: complete.schemaVersion,
    configHash: fs.existsSync(configPath) ? fileHash(configPath) : hashOf(`${JSON.stringify(config, null, 2)}\n`),
    allowlistKeys,
    retiredModels: union(RETIRED_MODELS, list(complete.retiredModels)),
    bannedModels,
    planRestrictedModels: list(complete.planRestrictedModels),
    allowFastModes: complete.allowFastModes === true,
  }, null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) writeAtomic(file, text);
  return file;
}

/** Deletes a generated file that is never listed in the manifest. */
function removeGenerated(target, relative, log) {
  const file = safePath(target, relative);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    fs.rmSync(file);
    log(`removed: ${relative}`);
  }
}

/** Only a v3 config has a snapshot; any other leaves none behind to go stale. */
function refreshSnapshot(target, config, log) {
  if (isV3(config)) writeRuntimeSnapshot(target, config);
  else removeGenerated(target, RUNTIME_SNAPSHOT_FILE, log);
}

export const renderInstalledSkill = (config, target) => Buffer.from(renderSkill(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'skills', 'auto-build', 'SKILL.md.tmpl'), 'utf8'),
  // Both ban lists apply, as in the hooks.
  { ...config, bannedModels: union(config.bannedModels, config.userBannedModels ?? []) },
  target,
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
  refreshSnapshot(target, complete, log);
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
  const root = path.resolve(target);
  for (const [relative, hash] of entries) {
    const file = safePath(root, relative);
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
    for (let dir = path.dirname(file); dir !== root; dir = path.dirname(dir)) {
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
export function desiredFiles(target, modules, config) {
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
export function applySettings(settings, merged, manifest, log) {
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
  if (auto) {
    for (const name of [CONFIG_FILE, RUNTIME_SNAPSHOT_FILE]) {
      const file = path.join(target, name);
      if (fs.existsSync(file) && !safePath(target, name)) throw new CliError(`${file} is a symlink; refusing to manage it`);
    }
  }
  const config = auto ? planConfig(configPath, options) : null;

  const desired = desiredFiles(target, modules, config?.complete);
  // Old and new hook files cannot be mixed: one kept edit could leave the guards unable to load.
  if (auto && !options.force) {
    for (const relative of HOOK_FILES) {
      const hook = safePath(target, relative);
      if (!fs.existsSync(hook)) continue;
      const current = fileHash(hook);
      if (current !== hashOf(desired.get(relative)) && current !== manifest?.files[relative]) {
        throw new CliError(`${hook} has local changes; run t3-auto-build init --force (it backs them up and replaces all hooks)`);
      }
    }
  }
  const tiered = auto && isSupportedSchema(config.complete);
  const merged = auto
    ? mergeSettings(settings.data, target, config.complete.compactionThreshold, manifest?.env, tiered ? config.complete.parent : undefined)
    : null;
  if (tiered) {
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
  refreshSnapshot(target, config?.complete, log);

  const record = () => writeManifest(target, {
    version: 1, packageVersion: PACKAGE_VERSION, modules, files, ...(merged && { env: merged.env }), skillTargets, skillMirrors,
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
  // Generated caches. The usage ledger is the user's history and stays.
  for (const name of [AVAILABILITY_FILE, QUOTA_FILE, RUNTIME_SNAPSHOT_FILE]) removeGenerated(target, name, log);
  fs.rmSync(path.join(target, MANIFEST_FILE));
  log(`done: uninstalled from ${target}`);
}

// Staged, recoverable upgrade of a v1 or v2 installation to the current schema.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CONFIG_FILE, RETIRED_MODELS, RUNTIME_SNAPSHOT_FILE, SCHEMA_VERSION, canonicalProvider, inferProvider, isObject,
  isStringList, isSupportedSchema, isV3, normalizeModel, normalizeName, readJson,
} from '../../hooks/_shared.mjs';
import { MANIFEST_FILE, fileHash, hashOf, readManifest, writeManifest } from '../manifest.mjs';
import { pathKey, resolveMirrorDirs, safeMirrorFile, syncMirrors } from '../mirrors.mjs';
import { CliError, PACKAGE_VERSION, safePath } from '../paths.mjs';
import { toConfig } from '../plans.mjs';
import { summaryTable } from '../prompt.mjs';
import { LADDERS } from '../render.mjs';
import { HOOKS, hookCommand, mergeSettings, readSettings } from '../settings.mjs';
import { RULES_FILE } from '../ref.mjs';
import { HOOK_FILES, SKILL, completeConfig, configProblem, inferSubscriptions, resolve, union, userBans, wantsAuto } from './plan.mjs';
import {
  applySettings, backUp, desiredFiles, renderInstalledSkill, rulesContent, writeAtomic, writeConfig, writeManaged, writeRuntimeSnapshot,
} from './write.mjs';

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

/** A v1 config rebuilt from the subscriptions its providers imply. */
function fromV1(existing) {
  const old = completeConfig(existing);
  const resolved = resolve(inferSubscriptions(old));
  const config = toConfig(resolved, { userBannedModels: userBans(existing), compactionThreshold: old.compactionThreshold });
  config.schemaVersion = SCHEMA_VERSION;
  config.ladders = migrateLadders(existing.ladders, resolved);
  config.defaultEffort = old.defaultEffort;
  for (const key of ['modelIds', 'discovery', 'quota']) if (existing[key] !== undefined) config[key] = existing[key];
  return config;
}

/** A v2 config keeps every setting; only the schema moves and newly retired models are added. */
const fromV2 = (existing) => ({
  ...existing,
  schemaVersion: SCHEMA_VERSION,
  retiredModels: union(isStringList(existing.retiredModels) ? existing.retiredModels : [], RETIRED_MODELS),
});

/** Removes the backups in "created", ignoring ones that cannot be removed. */
function discard(created) {
  for (const backup of created) {
    try {
      fs.rmSync(backup, { force: true });
    } catch {
      // a leftover backup is harmless
    }
  }
}

/** Writes a .bak of every file that exists, and notes the files and directories that do not exist yet. */
function stage(paths) {
  const saved = [];
  const created = [];
  const newDirs = new Set();
  try {
    for (const file of new Set(paths)) {
      if (fs.existsSync(file)) {
        saved.push({ file, backup: backUp(file, created) });
        continue;
      }
      saved.push({ file, backup: null });
      for (let dir = path.dirname(file); !fs.existsSync(dir); dir = path.dirname(dir)) newDirs.add(dir);
    }
  } catch (error) {
    discard(created);
    throw error;
  }
  return { saved, created, newDirs };
}

/** Puts every staged file back. Returns the files that could not be restored; their backups are then kept. */
function rollBack({ saved, created, newDirs }) {
  const failed = [];
  for (const { file, backup } of saved) {
    try {
      if (!backup) {
        if (fs.existsSync(file)) fs.rmSync(file);
        continue;
      }
      const content = fs.readFileSync(backup);
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) writeAtomic(file, content);
    } catch {
      failed.push(backup ? `${file} (backup: ${backup})` : file);
    }
  }
  if (failed.length === 0) discard(created);
  for (const dir of [...newDirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir); // only succeeds when empty
    } catch {
      // not empty, or never created
    }
  }
  return failed;
}

/** Existing and planned mirror files that syncMirrors may change. Manifest paths are untrusted. */
function mirrorFiles(target, manifest) {
  const recorded = Object.keys(manifest.skillMirrors ?? {}).filter((file) => {
    const safe = safeMirrorFile(path.dirname(path.dirname(file)));
    return safe !== null && pathKey(safe) === pathKey(file);
  });
  const planned = resolveMirrorDirs(manifest.skillTargets ?? 'auto', { target }).map(safeMirrorFile).filter(Boolean);
  // Anything that is not a regular file is left to syncMirrors, which warns and skips it.
  return [...recorded, ...planned].filter((file) => !fs.existsSync(file) || fs.statSync(file).isFile());
}

/**
 * Converts a v1 or v2 installation to the current schema. Order: backups, hooks (they also read the old config),
 * config and runtime snapshot, then SKILL.md, mirrors, manifest and settings. A failed write restores the backups.
 */
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
  if (isV3(existing)) {
    // A v3 install from before the rules file existed still needs it: its skill points there.
    if (manifest && wantsAuto(manifest.modules) && !Object.hasOwn(manifest.files, RULES_FILE)) {
      const files = { ...manifest.files };
      writeManaged(target, new Map([[RULES_FILE, rulesContent()]]), files, { log });
      writeManifest(target, { ...manifest, files });
    }
    log(`${CONFIG_FILE} is already schema version ${SCHEMA_VERSION}; nothing to do`);
    return { upgraded: false, backup: null, config: existing };
  }
  const v1 = existing.schemaVersion === undefined || existing.schemaVersion === 1;
  if (!v1 && !isSupportedSchema(existing)) {
    throw new CliError(`${file}: unknown schemaVersion ${JSON.stringify(existing.schemaVersion)}; not upgrading`);
  }
  const normalized = existing.retiredModels !== undefined && !isStringList(existing.retiredModels)
    ? { ...existing, retiredModels: [] }
    : existing;
  const problem = configProblem(completeConfig(normalized));
  if (problem) throw new CliError(`${file}: ${problem}`);

  const config = v1 ? fromV1(existing) : fromV2(existing);
  const complete = completeConfig(config);

  // Plan and validate everything before the first write.
  const auto = manifest !== null && wantsAuto(manifest.modules);
  if (auto) HOOKS.forEach((hook) => hookCommand(target, hook.script));
  const settings = auto ? readSettings(target) : null;
  const skill = renderInstalledSkill(complete, target);
  // Hooks and the rules file added since the old install are installed too; other files only when the manifest owns them.
  const desired = [...(manifest ? desiredFiles(target, manifest.modules, complete) : [])]
    .filter(([relative]) => HOOK_FILES.includes(relative) || relative === RULES_FILE || Object.hasOwn(manifest.files, relative));
  const hooks = new Map(desired.filter(([relative]) => HOOK_FILES.includes(relative)));
  const others = new Map(desired.filter(([relative]) => !HOOK_FILES.includes(relative)));
  // Old and new hook files cannot be mixed: one kept edit could leave the guards unable to load.
  for (const [relative, content] of hooks) {
    const hook = safePath(target, relative);
    if (!fs.existsSync(hook)) continue;
    const current = fileHash(hook);
    if (current !== hashOf(content) && current !== manifest.files[relative]) {
      throw new CliError(`${hook} has local changes; run t3-auto-build init --force (it backs them up), then upgrade again`);
    }
  }
  const merged = auto
    ? mergeSettings(settings.data, target, complete.compactionThreshold, manifest.env, complete.parent)
    : null;

  if (v1) {
    log(summaryTable(config));
    log('note: tiers are assumed from your v1 providers; run init with --claude-tier, --codex-tier, --antigravity-tier to set yours');
  }

  const settingsChange = merged && !isDeepStrictEqual(settings.data, merged.data) ? settings.file : null;
  let staged;
  let backup;
  try {
    staged = stage([
      file,
      ...desired.map(([relative]) => safePath(target, relative)),
      auto && safePath(target, RUNTIME_SNAPSHOT_FILE),
      ...(auto ? mirrorFiles(target, manifest) : []),
      manifest && path.join(target, MANIFEST_FILE),
      settingsChange,
    ].filter(Boolean));

    const files = { ...manifest?.files };
    writeManaged(target, hooks, files, { log });
    backup = writeConfig(file, `${JSON.stringify(config, null, 2)}\n`, files, { alwaysBackUp: true, log });
    if (auto) writeRuntimeSnapshot(target, config);
    writeManaged(target, others, files, { log });
    const skillMirrors = auto
      ? syncMirrors(target, others.get(SKILL) ?? skill, {
        skillTargets: manifest.skillTargets ?? 'auto', existingMirrors: manifest.skillMirrors, log,
      })
      : manifest?.skillMirrors;
    // As in install: the prior settings values are on record before settings.json changes.
    if (manifest) writeManifest(target, { ...manifest, packageVersion: PACKAGE_VERSION, files, ...(merged && { env: merged.env }), skillMirrors });
    if (merged) applySettings(settings, merged, manifest, log);
  } catch (error) {
    const failed = staged ? rollBack(staged) : [];
    const outcome = failed.length ? `could not restore: ${failed.join(', ')}` : 'no changes were kept';
    throw new CliError(`upgrade failed (${error.message}); ${outcome}`);
  }
  // The config and settings backups stay for the user; the rest only served the rollback.
  const keep = new Set([file, settingsChange]);
  discard(staged.saved.filter((entry) => !keep.has(entry.file) && staged.created.includes(entry.backup))
    .map((entry) => entry.backup));
  if (merged) log('Restart T3 Code (and any running Claude Code session) so hooks and settings load.');
  return { upgraded: true, backup, config };
}

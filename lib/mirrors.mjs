// Multi-provider SKILL.md mirroring for Codex, shared .agents, and T3 Antigravity. Node >=18, node:* only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileHash, hashOf } from './manifest.mjs';
import { CliError, safePath } from './paths.mjs';
import { backUp } from './settings.mjs';

const MIRROR_REL = 'auto-build/SKILL.md';

const isRealDir = (dir) => {
  try {
    const stat = fs.lstatSync(dir);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
};

export const pathKey = (p) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Parses --skill-targets: "auto", "none", or a comma-separated list of skill root directories. */
export function parseSkillTargets(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const lower = text.toLowerCase();
  if (lower === 'auto' || lower === 'none') return lower;
  const dirs = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (!dirs.length) throw new CliError('--skill-targets needs auto, none, or a comma-separated list of directories', 2);
  return [...new Map(dirs.map((dir) => [pathKey(dir), path.resolve(dir)])).values()];
}

const isWithin = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Existing external provider skill roots under home (never creates missing provider config trees). */
export function discoverSkillDirs({ home = os.homedir(), target } = {}) {
  const roots = [];
  const base = path.resolve(home);
  for (const parent of ['.codex', '.agents']) {
    const dir = path.join(base, parent);
    if (isRealDir(dir)) roots.push(path.join(dir, 'skills'));
  }
  const geminiConfig = path.join(base, '.gemini', 'config');
  if (isRealDir(geminiConfig)) roots.push(path.join(geminiConfig, 'skills'));
  const agyRoot = path.join(base, '.t3', 'userdata', 'providers', 'antigravity');
  if (isRealDir(agyRoot)) {
    try {
      for (const entry of fs.readdirSync(agyRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const configDir = path.join(agyRoot, entry.name, 'config');
        if (!isRealDir(configDir)) continue;
        const skillsDir = path.join(configDir, 'skills');
        try {
          if (fs.lstatSync(skillsDir).isSymbolicLink()) {
            const real = fs.realpathSync(skillsDir);
            if (isWithin(base, real) && isRealDir(real)) roots.push(real);
            continue;
          }
        } catch {
          // skillsDir does not exist yet: safe to use directly
        }
        roots.push(skillsDir);
      }
    } catch {
      // unreadable provider root: skip silently
    }
  }
  const primary = target ? pathKey(path.join(target, 'skills')) : null;
  const unique = new Map();
  for (const dir of roots) {
    const key = pathKey(dir);
    if (key !== primary && !unique.has(key)) unique.set(key, path.resolve(dir));
  }
  return [...unique.values()].sort((a, b) => (a < b ? -1 : 1));
}

/** Safe absolute path to <root>/auto-build/SKILL.md, or null if root or any child segment is a symlink. */
export function safeMirrorFile(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) return null;
  const dir = path.resolve(root);
  if (!path.isAbsolute(dir)) return null;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return null;
  } catch (error) {
    if (error.code !== 'ENOENT') return null;
  }
  return safePath(dir, MIRROR_REL);
}

/** Resolves skillTargets ("auto" | "none" | string[]) to deduplicated mirror root directories. */
export function resolveMirrorDirs(skillTargets = 'auto', { home = os.homedir(), target } = {}) {
  if (skillTargets === 'none') return [];
  if (skillTargets === 'auto' || skillTargets === undefined) return discoverSkillDirs({ home, target });
  if (!Array.isArray(skillTargets)) return [];
  const primary = target ? pathKey(path.join(target, 'skills')) : null;
  const unique = new Map();
  for (const dir of skillTargets) {
    const key = pathKey(dir);
    if (key !== primary && !unique.has(key)) unique.set(key, path.resolve(dir));
  }
  return [...unique.values()].sort((a, b) => (a < b ? -1 : 1));
}

function removeMirrorFile(file, expectedHash, log) {
  const root = path.dirname(path.dirname(file));
  const checked = safeMirrorFile(root);
  if (!checked || pathKey(checked) !== pathKey(file)) {
    log(`warning: ignored unsafe mirror path ${JSON.stringify(file)}`);
    return false;
  }
  if (!fs.existsSync(file)) return true;
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fileHash(file) !== expectedHash) {
    log(`kept (modified since install): ${file}`);
    return false;
  }
  fs.rmSync(file);
  log(`removed mirror: ${file}`);
  try {
    fs.rmdirSync(path.dirname(file)); // only succeeds when auto-build/ is empty
  } catch {
    // non-empty or already removed
  }
  return true;
}

/** Writes SKILL.md to each desired mirror root and prunes stale unchanged mirrors. Returns updated mirror hash map. */
export function syncMirrors(target, content, {
  skillTargets = 'auto', existingMirrors = {}, force = false, log = console.log, home = os.homedir(),
} = {}) {
  const roots = resolveMirrorDirs(skillTargets, { home, target });
  const next = { ...existingMirrors };
  const existingByKey = new Map(Object.entries(existingMirrors).map(([file, hash]) => [pathKey(file), { file, hash }]));
  const desiredKeys = new Set();
  const desiredHash = hashOf(content);

  for (const root of roots) {
    const file = safeMirrorFile(root);
    if (!file) {
      log(`warning: skipped skill mirror in ${root} (symlink in its path)`);
      continue;
    }
    const key = pathKey(file);
    desiredKeys.add(key);
    const prior = existingByKey.get(key);
    try {
      if (fs.existsSync(file)) {
        const current = fileHash(file);
        if (current === desiredHash) {
          // As in writeManaged: a plain run never claims a file it did not write.
          if (force || prior) {
            if (prior && prior.file !== file) delete next[prior.file];
            next[file] = current;
          }
          continue;
        }
        if (current !== prior?.hash) {
          if (!force) {
            log(`warning: skipped skill mirror ${file} (existing file with your changes; --force backs it up and overwrites)`);
            continue;
          }
          log(`backed up: ${backUp(file)}`);
        }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      if (prior && prior.file !== file) delete next[prior.file];
      next[file] = desiredHash;
      log(`mirrored: ${file}`);
    } catch (error) {
      log(`warning: skipped skill mirror ${file} (${error.code ?? error.message})`);
    }
  }

  for (const [file, hash] of Object.entries(existingMirrors)) {
    if (desiredKeys.has(pathKey(file))) continue;
    if (removeMirrorFile(file, hash, log)) delete next[file];
  }
  return next;
}

/** Removes all unchanged mirrored SKILL.md files. Returns the entries that were kept (modified). */
export function removeMirrors(existingMirrors = {}, log = console.log) {
  const kept = {};
  for (const [file, hash] of Object.entries(existingMirrors ?? {})) {
    if (!removeMirrorFile(file, hash, log)) kept[file] = hash;
  }
  return kept;
}

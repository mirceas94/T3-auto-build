// Every test runs in a throwaway directory with HOME, USERPROFILE, APPDATA, LOCALAPPDATA and CLAUDE_CONFIG_DIR
// pointed into it, PATH stripped of any directory containing codex/claude/agy/antigravity shims (while keeping
// node and git reachable), and T3AB_QUOTA_READERS=off as the defense-in-depth guarantee against real CLI calls.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../hooks/_shared.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'cli.mjs');
const GIT = which('git');
const PROVIDER_SHIM = /^(?:codex|claude|agy|antigravity)(?:\.(?:cmd|bat|exe|com|ps1))?$/i;

function hasProviderShim(dir) {
  try {
    return fs.readdirSync(dir).some((entry) => PROVIDER_SHIM.test(entry));
  } catch {
    return false;
  }
}

function exposeBinary(binDir, name, target) {
  const ext = process.platform === 'win32' ? path.extname(target) : '';
  const dest = path.join(binDir, `${name}${ext}`);
  for (const link of [() => fs.symlinkSync(target, dest), () => fs.linkSync(target, dest)]) {
    try {
      link();
      return;
    } catch {
      // try next strategy
    }
  }
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${target}" %*\r\n`);
  }
}

function buildSafePath(dir) {
  const dirs = [];
  const needed = [];
  const add = (name, target) => {
    const parent = path.dirname(target);
    if (!hasProviderShim(parent)) dirs.push(parent);
    else needed.push([name, target]);
  };
  add('node', process.execPath);
  if (GIT) add('git', GIT);
  if (needed.length) {
    const safeBin = path.join(dir, 'safe bin');
    fs.mkdirSync(safeBin, { recursive: true });
    for (const [name, target] of needed) exposeBinary(safeBin, name, target);
    dirs.unshift(safeBin);
  }
  return [...new Set(dirs)].join(path.delimiter);
}

export function sandbox(t) {
  // The spaces in these names exercise quoting everywhere.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3ab test ')));
  const home = path.join(dir, 'home dir');
  const appdata = path.join(home, 'AppData', 'Roaming');
  const localAppdata = path.join(home, 'AppData', 'Local');
  const target = path.join(home, 'config dir');
  fs.mkdirSync(appdata, { recursive: true });
  fs.mkdirSync(localAppdata, { recursive: true });
  const safePath = buildSafePath(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PATH|APPDATA|LOCALAPPDATA)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appdata,
    LOCALAPPDATA: localAppdata,
    CLAUDE_CONFIG_DIR: target,
    PATH: safePath,
    T3AB_QUOTA_READERS: 'off',
  });
  const saved = {
    PATH: process.env.PATH,
    T3AB_QUOTA_READERS: process.env.T3AB_QUOTA_READERS,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  process.env.PATH = safePath;
  process.env.T3AB_QUOTA_READERS = 'off';
  process.env.APPDATA = appdata;
  process.env.LOCALAPPDATA = localAppdata;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    home,
    target,
    env,
    path: (...parts) => path.join(target, ...parts),
    cli: (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8', input: '' }),
    hook(name, payload, options = {}) {
      return spawnSync(process.execPath, [path.join(target, 'hooks', 't3-auto-build', `${name}.mjs`)], {
        cwd: dir,
        env,
        encoding: 'utf8',
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ...options,
      });
    },
  };
}

export const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
export const read = (file) => fs.readFileSync(file, 'utf8');
export const json = (file) => JSON.parse(read(file));

/** { relative path: content } for every file under dir. */
export function tree(dir, base = dir, found = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(file, base, found);
    else found[path.relative(base, file).replace(/\\/g, '/')] = read(file);
  }
  return found;
}

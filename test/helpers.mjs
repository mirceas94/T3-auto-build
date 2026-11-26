// Every test runs in a throwaway directory with HOME, USERPROFILE and CLAUDE_CONFIG_DIR pointed into it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'cli.mjs');

export function sandbox(t) {
  // The spaces in these names exercise quoting everywhere.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3ab test ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const home = path.join(dir, 'home dir');
  const target = path.join(home, 'config dir');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: target };
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { run, which } from '../hooks/_shared.mjs';
import { json, read, ROOT, sandbox } from './helpers.mjs';

const { version } = json(path.join(ROOT, 'package.json'));
const RUNTIME = ['bin', 'core', 'hooks', 'lib', 'presets', 'skills'];

// OS and editor litter that npm or .gitignore keeps out of the tarball.
const LITTER = /^\.|\.(bak|orig)$/;

// npm paths always use forward slashes.
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  if (LITTER.test(entry.name)) return [];
  const name = path.posix.join(dir, entry.name);
  return entry.isDirectory() ? walk(name) : [name];
});

test('shipped modules import only node: built-ins and shipped files, and hooks never reach into lib', () => {
  const modules = RUNTIME.flatMap(walk).filter((file) => file.endsWith('.mjs'));
  let checked = 0;
  for (const file of modules) {
    for (const [, specifier] of read(path.join(ROOT, file)).matchAll(/^(?:import\s+(?:[^'";]*?\bfrom\s*)?|export\s+[^'";=]*?\bfrom\s*)['"]([^'"\r\n]+)['"]/gm)) {
      checked += 1;
      if (specifier.startsWith('node:')) continue;
      assert.match(specifier, /^\.\.?\//, `${file} imports ${specifier}`);
      const resolved = path.posix.join(path.posix.dirname(file), specifier);
      assert.ok(modules.includes(resolved), `${file} imports ${specifier}, which is not shipped`);
      if (file.startsWith('hooks/')) assert.ok(resolved.startsWith('hooks/'), `${file} imports ${specifier}`);
    }
  }
  assert.ok(checked > modules.length);
});

test('the packed tarball ships the right files and runs through npx', { skip: !which('npm') && 'npm is not installed' }, (t) => {
  const box = sandbox(t);
  const state = path.join(box.dir, 'npm');
  fs.mkdirSync(state);
  // Keep every npm read and write inside the sandbox, and stay offline.
  Object.assign(box.env, {
    APPDATA: state,
    LOCALAPPDATA: state,
    TMPDIR: state,
    TEMP: state,
    TMP: state,
    npm_config_cache: path.join(state, 'cache'),
    npm_config_userconfig: path.join(state, 'npmrc'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  });
  const npm = (cwd, ...args) => {
    const result = run(which('npm'), args, { cwd, env: box.env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result?.status, 0, result?.stderr ?? 'npm was skipped: unsafe argument');
    return result.stdout;
  };

  // npm <=11 prints an array, newer npm an object keyed by package name.
  const [packed] = Object.values(JSON.parse(npm(ROOT, 'pack', '--json', '--pack-destination', box.dir)));
  const files = packed.files.map((file) => file.path);
  for (const needed of ['bin/cli.mjs', 'lib/install.mjs', 'hooks/_shared.mjs', 'core/CLAUDE.md', 'presets/tri-provider.json', 'skills/auto-build/SKILL.md.tmpl', 'LICENSE', 'README.md', 'CHANGELOG.md', 'lib/plans.mjs', 'lib/discover.mjs']) {
    assert.ok(files.includes(needed), needed);
  }
  assert.deepEqual(files.filter((file) => /^(test|\.claude|\.sandbox|\.github|assets)\/|^(CONTRIBUTING|SECURITY)\.md$/.test(file)), []);
  // Exactly the runtime tree plus the standard files: nothing missing, nothing stray.
  const expected = [...RUNTIME.flatMap(walk), 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
  assert.deepEqual([...files].sort(), expected.sort());
  assert.equal(packed.version, version);

  const tarball = path.join(box.dir, packed.filename);
  const packaged = (...args) => npm(box.home, 'exec', '--yes', `--package=${tarball}`, '--', 't3-auto-build', ...args);
  assert.equal(packaged('--version').trim(), version);
  packaged('init', '--yes');
  assert.ok(fs.existsSync(box.path('hooks', 't3-auto-build', 'pre-tool-use.mjs')));
});

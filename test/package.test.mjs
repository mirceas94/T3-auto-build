import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { run, which } from '../hooks/_shared.mjs';
import { ROOT, sandbox } from './helpers.mjs';

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
  for (const needed of ['bin/cli.mjs', 'lib/install.mjs', 'hooks/_shared.mjs', 'core/CLAUDE.md', 'presets/tri-provider.json', 'skills/auto-build/SKILL.md.tmpl', 'LICENSE', 'README.md']) {
    assert.ok(files.includes(needed), needed);
  }
  assert.deepEqual(files.filter((file) => /^(test|\.claude|\.sandbox|\.github|assets)\/|^(CONTRIBUTING|SECURITY)\.md$/.test(file)), []);

  const tarball = path.join(box.dir, packed.filename);
  npm(box.home, 'exec', '--yes', `--package=${tarball}`, '--', 't3-auto-build', 'init', '--yes');
  assert.ok(fs.existsSync(box.path('hooks', 't3-auto-build', 'pre-tool-use.mjs')));
});

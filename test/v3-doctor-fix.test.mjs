import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { which } from '../hooks/_shared.mjs';
import { read, sandbox, tree, write } from './helpers.mjs';

const GIT = which('git');
const HOOK = ['hooks', 't3-auto-build', 'pre-tool-use.mjs'];
const SNAPSHOT = 'auto-build-runtime.json';
const CONFIG = 'auto-build.config.json';
const EXCLUDE = '/.claude/auto-build-state.json';

/**
 * A v3 install with one skill mirror in the sandbox home, run through the CLI so "auto" mirror dirs never leave it.
 * doctor checks the project in box.project, a fresh repository when git is available.
 */
function setup(t) {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, '.codex'));
  // No global or system excludes file may decide whether the state file is already ignored.
  Object.assign(box.env, {
    XDG_CONFIG_HOME: path.join(box.home, 'xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: box.dir,
  });
  delete box.env.GIT_CONFIG_GLOBAL;
  const init = box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus');
  assert.equal(init.status, 0, init.stderr);
  box.mirror = path.join(box.home, '.codex', 'skills', 'auto-build', 'SKILL.md');
  box.project = path.join(box.dir, 'my project');
  fs.mkdirSync(box.project);
  if (GIT) assert.equal(spawnSync(GIT, ['-C', box.project, 'init', '-q'], { env: box.env }).status, 0);
  box.exclude = path.join(box.project, '.git', 'info', 'exclude');
  box.doctor = (...flags) => box.cli('doctor', '--cwd', box.project, ...flags);
  return box;
}

const excluded = (box) => (fs.existsSync(box.exclude) ? read(box.exclude).split(/\r?\n/) : [])
  .filter((line) => line === EXCLUDE).length;

/** Drifts the hook, the mirror and the snapshot; returns the original contents. */
function drift(box) {
  const original = { hook: read(box.path(...HOOK)), mirror: read(box.mirror), snapshot: read(box.path(SNAPSHOT)) };
  write(box.path(...HOOK), '// edited\n');
  write(box.mirror, 'edited mirror\n');
  write(box.path(SNAPSHOT), '{}');
  return original;
}

test('doctor --fix without --yes only reports', (t) => {
  const box = setup(t);
  drift(box);
  const before = tree(box.dir);
  const result = box.doctor('--fix');
  assert.match(result.stdout, /^would fix: .*re-run with --fix --yes/m);
  for (const part of ['hook hooks/t3-auto-build/pre-tool-use.mjs', 'skill mirror ', SNAPSHOT]) {
    assert.ok(result.stdout.includes(part), part);
  }
  if (GIT) assert.ok(result.stdout.includes(`git exclude ${EXCLUDE}`), result.stdout);
  assert.deepEqual(tree(box.dir), before);
});

test('doctor --fix --yes repairs drift with backups and is idempotent', (t) => {
  const box = setup(t);
  const original = drift(box);
  const config = read(box.path(CONFIG));
  const settings = read(box.path('settings.json'));

  const result = box.doctor('--fix', '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^fixed: /m);
  assert.equal(read(box.path(...HOOK)), original.hook);
  assert.equal(read(`${box.path(...HOOK)}.bak`), '// edited\n');
  assert.equal(read(box.mirror), original.mirror);
  assert.equal(read(`${box.mirror}.bak`), 'edited mirror\n');
  assert.equal(read(box.path(SNAPSHOT)), original.snapshot);
  assert.equal(excluded(box), GIT ? 1 : 0);
  assert.equal(read(box.path(CONFIG)), config);
  assert.equal(read(box.path('settings.json')), settings);

  const after = tree(box.dir);
  const second = box.doctor('--fix', '--yes');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /^nothing to fix$/m);
  assert.deepEqual(tree(box.dir), after);
});

test('doctor --fix restores missing files', (t) => {
  const box = setup(t);
  const hook = read(box.path(...HOOK));
  for (const file of [box.path(...HOOK), box.mirror, box.path(SNAPSHOT)]) fs.rmSync(file);
  const result = box.doctor('--fix', '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(box.path(...HOOK)), hook);
  for (const file of [box.mirror, box.path(SNAPSHOT)]) assert.ok(fs.existsSync(file), file);
});

test('doctor without --fix writes nothing; --yes alone is refused', (t) => {
  const box = setup(t);
  drift(box);
  const before = tree(box.dir);
  assert.doesNotMatch(box.doctor().stdout, /fixed:|would fix:/);
  const refused = box.doctor('--yes');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--yes is only valid with doctor --fix/);
  assert.deepEqual(tree(box.dir), before);
});

for (const [name, bad, reason] of [
  ['unparsable', '{ nope', /is not valid JSON/],
  ['unknown schema', null, /schemaVersion must be 2 or 3/],
]) {
  test(`doctor --fix with an ${name} config fails, leaves it alone and still repairs hooks`, (t) => {
    const box = setup(t);
    const text = bad ?? JSON.stringify({ ...JSON.parse(read(box.path(CONFIG))), schemaVersion: 4 });
    const original = drift(box);
    write(box.path(CONFIG), text);
    const result = box.doctor('--fix', '--yes');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, reason);
    assert.equal(read(box.path(CONFIG)), text);
    assert.equal(read(box.path(...HOOK)), original.hook);
    // Nothing derived from the config is rebuilt.
    assert.equal(read(box.mirror), 'edited mirror\n');
    assert.equal(read(box.path(SNAPSHOT)), '{}');
  });
}

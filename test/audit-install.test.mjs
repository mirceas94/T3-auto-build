// Regression tests for the audit blockers in the CLI and installer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { writeCooldowns } from '../hooks/_quota.mjs';
import { checkModels, markAvailability, readAvailabilityFile } from '../lib/discover.mjs';
import { configProblem, loadPreset, moduleFiles, uninstall } from '../lib/install.mjs';
import { hashOf, readManifest, writeManifest } from '../lib/manifest.mjs';
import { syncMirrors } from '../lib/mirrors.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { syncModels } from '../lib/probe.mjs';
import { backUp } from '../lib/settings.mjs';
import { json, read, sandbox, write } from './helpers.mjs';

const ok = (result) => assert.equal(result.status, 0, result.stderr);
const CONFIG = 'auto-build.config.json';
const MANIFEST = 't3-auto-build.manifest.json';

/** Empties PATH, so no real provider CLI is ever probed. */
function noBinaries(box) {
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key];
  box.env.PATH = path.join(box.dir, 'empty bin');
}

test('sync-models --force --yes backs up and replaces an edited SKILL.md', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  const skill = box.path('skills', 'auto-build', 'SKILL.md');
  write(skill, 'edited\n');
  noBinaries(box);
  ok(box.cli('sync-models', '--force', '--yes'));
  assert.equal(read(`${skill}.bak`), 'edited\n');
  assert.notEqual(read(skill), 'edited\n');
});

test('a later settings.json backup never overwrites the pre-install one', (t) => {
  const box = sandbox(t);
  write(box.path('settings.json'), '{"theme":"dark"}');
  ok(box.cli('init', '--yes', '--compaction', '60'));
  const second = read(box.path('settings.json'));
  ok(box.cli('init', '--yes', '--compaction', '70'));
  assert.equal(read(box.path('settings.json.bak')), '{"theme":"dark"}');
  assert.equal(read(box.path('settings.json.bak.1')), second);
});

test('malformed v2/v3 keys and an oversized preflight ttl are config problems', (t) => {
  const preset = loadPreset('tri-provider');
  for (const bad of [
    { models: 'bad' }, { models: [{ provider: 'codex' }] }, { retiredModels: 1 }, { planRestrictedModels: 'x' },
    { userBannedModels: [1] }, { subscriptions: 'pro' }, { preflight: 1 }, { preflight: { ttl: -1 } },
  ]) assert.notEqual(configProblem({ ...preset, ...bad }), null, JSON.stringify(bad));
  // A long ttl stays a valid config; preflight caps it.
  assert.equal(configProblem({ ...preset, models: [], preflight: { ttl: 9000000000000000 } }), null);

  const box = sandbox(t);
  write(box.path(CONFIG), { schemaVersion: 3, models: 'bad' });
  const result = box.cli('init', '--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /models entries/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('preflight caps an oversized ttl instead of throwing', async (t) => {
  const box = sandbox(t);
  write(box.path(CONFIG), { schemaVersion: 3, preflight: { ttl: 9000000000000000 } });
  const saved = process.env.PATH;
  process.env.PATH = path.join(box.dir, 'empty bin');
  t.after(() => { process.env.PATH = saved; });
  const result = await runPreflight({ configDir: box.target, cwd: box.dir, now: 0 });
  assert.equal(result.expiresAt, new Date(365 * 86_400_000).toISOString());
});

test('init --force records ownership again after the manifest is lost', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  fs.rmSync(box.path(MANIFEST));
  ok(box.cli('init', '--yes', '--force'));
  // The unchanged config may hold user edits, so it stays the user's.
  const managed = moduleFiles('full').filter((file) => file !== CONFIG);
  assert.deepEqual(Object.keys(json(box.path(MANIFEST)).files).sort(), managed.sort());
  ok(box.cli('uninstall'));
  for (const file of managed) assert.equal(fs.existsSync(box.path(file)), false, file);
  assert.equal(fs.existsSync(box.path(CONFIG)), true);
});

const COOLDOWNS = 'auto-build-cooldowns.json';
const NOW = Date.UTC(2026, 10, 26);
const lock = {
  scope: 'provider', window: 'weekly', until: new Date(NOW + 3_600_000).toISOString(), reason: 'test', source: 'manual',
};
/** Adds one lock the way another process would. */
const addLock = (file, key) => writeCooldowns(file, {
  ...(fs.existsSync(file) ? json(file) : {}), [key]: lock,
}, { now: NOW });

test('checkModels keeps a mark and a cooldown written while it probes', async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const file = box.path(COOLDOWNS);
  await checkModels({
    configDir: box.target,
    config: toConfig(resolveTiers({ claude: 'pro' })),
    which: (name) => path.join(box.dir, name),
    runner: () => ({ status: 0, stdout: '1.0.0', stderr: '' }),
    now: NOW,
    probe: async () => {
      markAvailability({ configDir: box.target, ref: 'codex:gpt-6-luna', status: 'unavailable', now: NOW });
      addLock(file, 'provider:codex');
      const entry = { ...lock };
      return {
        results: [{
          provider: 'claude', model: 'claude-sonnet-5-5', state: 'rate-limited',
          cooldown: { key: 'provider:claude', entry },
        }],
      };
    },
  });
  assert.equal(readAvailabilityFile(box.target).models['codex:gpt-6-luna'].source, 'mark');
  assert.deepEqual(Object.keys(json(file)).sort(), ['provider:claude', 'provider:codex']);
});

test('syncModels keeps a cooldown written while it saves the config', async (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes', '--skill-targets', 'none'));
  const file = box.path(COOLDOWNS);
  await syncModels(box.target, {
    providers: ['claude'], yes: true, now: NOW, log: () => {},
    runner: async () => ({ status: 1, stdout: '', stderr: 'weekly limit reached' }),
    syncFiles: async () => addLock(file, 'provider:codex'),
  });
  assert.ok(json(file)['provider:codex']);
  assert.ok(Object.keys(json(file)).length > 1);
});

test('a user ban on a CLI model id applies to probing, ladders and the snapshot', async (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes', '--skill-targets', 'none', '--claude-tier', 'pro'));
  const config = {
    ...toConfig(resolveTiers({ claude: 'pro' })),
    modelIds: { 'claude-opus-5-5': 'opus-id' },
    userBannedModels: ['opus-id'],
  };
  assert.ok(Object.values(config.allowlist).flat().includes('claude-opus-5-5'));
  write(box.path(CONFIG), config);
  const probed = [];
  const { results } = await syncModels(box.target, {
    yes: true, probeScarce: true, now: NOW, log: () => {},
    runner: async (cmd, args) => {
      probed.push(...args);
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.ok(probed.length > 0);
  assert.ok(!probed.includes('opus-id') && !probed.includes('claude-opus-5-5'));
  assert.ok(!results.some((r) => r.model === 'claude-opus-5-5'));
  const snapshot = json(box.path('auto-build-runtime.json'));
  assert.ok(snapshot.allowlistKeys.length > 0);
  assert.ok(!snapshot.allowlistKeys.includes('claude:claude-opus-5-5'));
  assert.doesNotMatch(read(box.path('skills', 'auto-build', 'SKILL.md')), /claude-opus-5-5/);
});

test('a plain init never claims a pre-existing identical file', (t) => {
  const box = sandbox(t);
  write(box.path('CLAUDE.md'), fs.readFileSync(new URL('../core/CLAUDE.md', import.meta.url), 'utf8'));
  ok(box.cli('init', '--yes'));
  ok(box.cli('uninstall'));
  assert.equal(fs.existsSync(box.path('CLAUDE.md')), true);
});

test('a mirror backup reuses an identical existing backup without rewriting it', (t) => {
  const box = sandbox(t);
  const root = path.join(box.dir, 'skills');
  const mirror = path.join(root, 'auto-build', 'SKILL.md');
  write(mirror, 'mine\n');
  write(`${mirror}.bak`, 'older\n');
  write(`${mirror}.bak.1`, 'mine\n');
  const stamp = new Date(Date.UTC(2020, 0, 1));
  fs.utimesSync(`${mirror}.bak.1`, stamp, stamp);
  syncMirrors(box.target, 'new\n', { skillTargets: [root], home: box.home, force: true, log: () => {} });
  assert.equal(read(mirror), 'new\n');
  assert.equal(read(`${mirror}.bak`), 'older\n');
  assert.equal(fs.statSync(`${mirror}.bak.1`).mtimeMs, stamp.getTime());
  assert.equal(fs.existsSync(`${mirror}.bak.2`), false);
});

test('a symlinked manifest is refused', (t) => {
  const box = sandbox(t);
  const outside = path.join(box.dir, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(box.target);
  fs.symlinkSync(outside, box.path(MANIFEST), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readManifest(box.target), /symlink/);
  assert.throws(() => writeManifest(box.target, { version: 1, modules: 'core', files: {} }), /symlink/);
});

test('backups and the manifest are never written through a file symlink', (t) => {
  const box = sandbox(t);
  const outside = path.join(box.dir, 'outside');
  const file = box.path('settings.json');
  write(file, 'mine\n');
  try {
    fs.symlinkSync(outside, `${file}.bak`, 'file'); // dangling: existsSync reports it as free
    fs.symlinkSync(outside, box.path(MANIFEST), 'file');
  } catch (error) {
    t.skip(`file symlinks unavailable: ${error.code ?? error.message}`);
    return;
  }
  assert.equal(backUp(file), `${file}.bak.1`);
  assert.throws(() => writeManifest(box.target, { version: 1, modules: 'core', files: {} }), /symlink/);
  assert.equal(fs.existsSync(outside), false);
});

test('only force or prior ownership claims a pre-existing identical mirror', (t) => {
  const box = sandbox(t);
  const root = path.join(box.dir, 'skills');
  const mirror = path.join(root, 'auto-build', 'SKILL.md');
  write(mirror, 'same\n');
  const sync = (options) => syncMirrors(box.target, 'same\n', {
    skillTargets: [root], home: box.home, log: () => {}, ...options,
  });
  assert.deepEqual(sync(), {});
  const owned = { [mirror]: hashOf('same\n') };
  assert.deepEqual(sync({ force: true }), owned);
  assert.deepEqual(sync({ existingMirrors: owned }), owned);

  ok(box.cli('init', '--yes', '--skill-targets', root));
  const manifest = json(box.path(MANIFEST));
  delete manifest.skillMirrors;
  write(box.path(MANIFEST), manifest);
  write(mirror, read(box.path('skills', 'auto-build', 'SKILL.md')));
  assert.match(box.cli('doctor', '--fix', '--yes').stdout, /skill mirror not managed/);
  ok(box.cli('uninstall'));
  assert.equal(fs.existsSync(mirror), true);
});

test('uninstall with a relative target never tries to remove the target itself', (t) => {
  const box = sandbox(t);
  write(box.path('sub', 'file.txt'), 'x');
  writeManifest(box.target, { version: 1, modules: 'core', files: { 'sub/file.txt': hashOf('x') } });
  const cwd = process.cwd();
  process.chdir(box.home);
  const rmdir = t.mock.method(fs, 'rmdirSync');
  try {
    uninstall(path.basename(box.target), () => {});
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(rmdir.mock.calls.map((call) => path.resolve(box.home, call.arguments[0])), [box.path('sub')]);
});

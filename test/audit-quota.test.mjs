// Regression tests for ELOCKED handling, quota clear --all recovery, upgrade retiredModels tolerance, and configProblem parity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AVAILABILITY_FILE, CONFIG_FILE, COOLDOWN_FILE, RETIRED_MODELS } from '../hooks/_shared.mjs';
import { updateCooldowns } from '../hooks/_quota.mjs';
import { markAvailability, updateAvailability, writeAvailability } from '../lib/discover/cache.mjs';
import { PRESETS, completeConfig, configProblem, install, loadPreset, upgrade } from '../lib/install.mjs';
import { CliError } from '../lib/paths.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { syncModels } from '../lib/probe.mjs';
import { quotaClear } from '../lib/quota.mjs';
import { json, read, sandbox, write } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 26, 12);
const quiet = { log: () => {} };

test('1: ELOCKED turns into CliError naming the lock path in cache.mjs and probe.mjs without raw stack traces', async (t) => {
  const box = sandbox(t);
  install(box.target, { skillTargets: 'none' }, () => {});

  // Broken availability lock path (directory) triggers immediate ELOCKED.
  const availLock = box.path(`${AVAILABILITY_FILE}.lock`);
  fs.mkdirSync(availLock);
  for (const fn of [
    () => writeAvailability(box.target, { checkedAt: new Date(NOW).toISOString(), ttlMs: 1000, models: {} }),
    () => updateAvailability(box.target, () => ({ checkedAt: new Date(NOW).toISOString(), ttlMs: 1000, models: {} })),
    () => markAvailability({ configDir: box.target, ref: 'codex:gpt-6-luna', status: 'unavailable', now: NOW }),
  ]) {
    assert.throws(fn, (error) => error instanceof CliError
      && error.message.includes(`${AVAILABILITY_FILE}.lock`)
      && /busy/.test(error.message));
  }
  const cliRes = box.cli('availability', 'mark', 'codex:gpt-6-luna', 'unavailable');
  assert.equal(cliRes.status, 1);
  assert.match(cliRes.stderr, /auto-build-availability\.json\.lock/);
  assert.doesNotMatch(cliRes.stderr, /unexpected error|at withFileLock/);

  // Broken cooldown lock path during syncModels cooldown update throws CliError naming the lock path.
  const cdLock = box.path(`${COOLDOWN_FILE}.lock`);
  fs.mkdirSync(cdLock);
  await assert.rejects(
    () => syncModels(box.target, {
      providers: ['claude'], yes: true, now: NOW, log: () => {},
      runner: async () => ({ status: 1, stdout: '', stderr: 'weekly limit reached' }),
      syncFiles: async () => {},
    }),
    (error) => error instanceof CliError
      && error.message.includes(`${COOLDOWN_FILE}.lock`)
      && /busy/.test(error.message),
  );
});

test('2: quota clear --all clears corrupt cooldowns with a warning across broken/held locks without following symlinks or recursive delete', (t) => {
  const box = sandbox(t);
  install(box.target, { skillTargets: 'none' }, () => {});
  const cdFile = box.path(COOLDOWN_FILE);
  const cdLock = `${cdFile}.lock`;

  // (a) Leftover empty .lock directory + corrupt cooldown file: clears file, cleans empty dir, warns.
  write(cdFile, '{ corrupt json');
  fs.mkdirSync(cdLock);
  const emptyLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => emptyLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.match(emptyLogs.join('\n'), /warning:.*auto-build-cooldowns\.json\.lock/);
  assert.match(emptyLogs.join('\n'), /cleared all cooldowns/);

  // (b) Non-empty .lock directory: clears cooldown file with warning, preserves unrelated files inside .lock.
  write(cdFile, '{ corrupt json');
  const unrelated = path.join(cdLock, 'keep.txt');
  write(unrelated, 'do not delete');
  const nonEmptyLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => nonEmptyLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(read(unrelated), 'do not delete');
  assert.match(nonEmptyLogs.join('\n'), /warning:/);
  fs.rmSync(cdLock, { recursive: true, force: true });

  // (c) Symlink/junction at .lock pointing to an unrelated directory: never followed, target intact, cooldown cleared.
  const outsideDir = path.join(box.dir, 'unrelated dir');
  const victim = path.join(outsideDir, 'victim.txt');
  write(victim, 'precious');
  fs.symlinkSync(outsideDir, cdLock, process.platform === 'win32' ? 'junction' : 'dir');
  write(cdFile, '{ corrupt json');
  const linkLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => linkLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(read(victim), 'precious');
  assert.ok(fs.lstatSync(cdLock).isSymbolicLink());
  assert.match(linkLogs.join('\n'), /warning:/);
  fs.rmSync(cdLock, { force: true });

  // (d) Held regular .lock file: invalidates lock with warning, clears cooldown file, and active holder's write aborts.
  write(cdFile, '{ corrupt json');
  write(cdLock, '99999:held\n');
  const heldLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => heldLogs.push(line), timeoutMs: 25 });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.match(heldLogs.join('\n'), /warning:.*timed out waiting for lock/);

  write(cdFile, { 'provider:codex': { scope: 'provider', window: '5h', until: new Date(NOW + 60_000).toISOString(), reason: 'held', source: 'manual' } });
  const holderLogs = [];
  assert.throws(() => {
    updateCooldowns(cdFile, (current, stillHeld) => {
      assert.equal(stillHeld(), true);
      quotaClear(box.target, { all: true }, { log: (line) => holderLogs.push(line), timeoutMs: 25 });
      assert.equal(stillHeld(), false);
      return { data: { ...current, 'provider:claude': { scope: 'provider', window: '5h', until: new Date(NOW + 60_000).toISOString(), reason: 'stale', source: 'manual' } } };
    }, { now: NOW });
  }, { code: 'ELOCKED' });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.match(holderLogs.join('\n'), /warning:.*timed out waiting for lock/);

  // (e) CLI end-to-end with broken .lock directory exits 0 and clears corrupt file.
  write(cdFile, '{ corrupt json');
  fs.mkdirSync(cdLock);
  const cliRes = box.cli('quota', 'clear', '--all');
  assert.equal(cliRes.status, 0, cliRes.stderr);
  assert.equal(fs.existsSync(cdFile), false);
  assert.match(cliRes.stdout, /warning:/);
  assert.match(cliRes.stdout, /cleared all cooldowns/);
});

test('3: upgrade tolerates v1 and v2 configs with non-string-list retiredModels while still rejecting broken fields', (t) => {
  // v2 with non-string-list retiredModels
  const boxV2 = sandbox(t);
  install(boxV2.target, { skillTargets: 'none', claudeTier: 'pro', codexTier: 'plus' }, () => {});
  const baseV2 = json(boxV2.path(CONFIG_FILE));
  delete baseV2.telemetry;
  delete baseV2.preflight;
  for (const weird of ['legacy-model', null, 123, [1, 'ok']]) {
    write(boxV2.path(CONFIG_FILE), { ...baseV2, schemaVersion: 2, retiredModels: weird });
    const res = upgrade(boxV2.target, quiet);
    assert.equal(res.upgraded, true, JSON.stringify(weird));
    assert.deepEqual(json(boxV2.path(CONFIG_FILE)).retiredModels, [...RETIRED_MODELS]);
  }

  // v1 with non-string-list retiredModels
  const boxV1 = sandbox(t);
  install(boxV1.target, { skillTargets: 'none' }, () => {});
  const baseV1 = json(boxV1.path(CONFIG_FILE));
  write(boxV1.path(CONFIG_FILE), { ...baseV1, retiredModels: 'old-model' });
  const resV1 = upgrade(boxV1.target, quiet);
  assert.equal(resV1.upgraded, true);
  assert.equal(json(boxV1.path(CONFIG_FILE)).schemaVersion, 3);
  assert.deepEqual(json(boxV1.path(CONFIG_FILE)).retiredModels, [...RETIRED_MODELS]);

  // Truly invalid other fields are still rejected even when retiredModels is normalized.
  write(boxV2.path(CONFIG_FILE), { ...baseV2, schemaVersion: 2, retiredModels: null, models: 'bad' });
  assert.throws(() => upgrade(boxV2.target, quiet), (error) => error instanceof CliError && /models entries/.test(error.message));
});

test('4: configProblem rejects v2/v3 fields silently dropped by hooks/_shared.mjs and accepts all valid configs', (t) => {
  const preset = loadPreset('tri-provider');

  // Invalid model entry fields and v2/v3 runtime fields must all be rejected.
  const invalid = [
    { models: [{ provider: 'codex', model: 'gpt-6-luna', pool: 123 }] },
    { models: [{ provider: 'codex', model: 'gpt-6-luna', scarceQuota: 'yes' }] },
    { allowFastModes: 'yes' },
    { maxParallelBuilders: -1 },
    { maxParallelBuilders: 1.5 },
    { maxParallelBuilders: '2' },
    { telemetry: 1 },
    { telemetry: { enabled: 'yes' } },
    { telemetry: { maxBytes: -1 } },
    { telemetry: { maxBytes: 1.5 } },
    { catalogOverrides: 'no' },
    { catalogOverrides: 1 },
    { catalogOverrides: null },
  ];
  for (const bad of invalid) {
    assert.notEqual(configProblem({ ...preset, ...bad }), null, JSON.stringify(bad));
  }

  // Every preset passes.
  for (const name of PRESETS) {
    assert.equal(configProblem(completeConfig(loadPreset(name))), null, name);
  }

  // Generated v3 configs pass.
  for (const subs of [
    { claude: 'pro' },
    { claude: 'max', codex: 'pro-200', antigravity: 'pro' },
    { codex: 'free', antigravity: 'free' },
  ]) {
    assert.equal(configProblem(completeConfig(toConfig(resolveTiers(subs)))), null, JSON.stringify(subs));
  }

  // Valid runtime-accepted optional shapes pass.
  for (const valid of [
    { models: [{ provider: 'codex', model: 'gpt-6-luna' }] },
    { models: [{ provider: 'codex', model: 'gpt-6-luna', pool: 'standard', scarceQuota: false }] },
    { allowFastModes: true, maxParallelBuilders: 0 },
    { telemetry: { enabled: false } },
    { telemetry: { maxBytes: 0 } },
    { catalogOverrides: false },
    { catalogOverrides: true },
    { catalogOverrides: {} },
  ]) {
    assert.equal(configProblem({ ...preset, ...valid }), null, JSON.stringify(valid));
  }

  // Upgraded v1 -> v3 config passes.
  const box = sandbox(t);
  install(box.target, { skillTargets: 'none' }, () => {});
  const upgraded = upgrade(box.target, quiet).config;
  assert.equal(configProblem(completeConfig(upgraded)), null);
});

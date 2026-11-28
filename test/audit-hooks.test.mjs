import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readCooldowns, writeCooldowns } from '../hooks/_quota.mjs';
import {
  AVAILABILITY_FILE, CATALOG_OVERRIDES_FILE, COOLDOWN_FILE, CONFIG_FILE, isBanned, modelKeys, resolveTarget,
  withFileLock, writeFileAtomic,
} from '../hooks/_shared.mjs';
import { readAvailabilityFile, writeAvailability } from '../lib/discover/cache.mjs';
import { quotaClear, quotaSet } from '../lib/quota.mjs';
import { ROOT, json, sandbox, write } from './helpers.mjs';

const CLI = path.join(ROOT, 'bin', 'cli.mjs');
const future = (ms = 60 * 60_000) => new Date(Date.now() + ms).toISOString();
const past = (ms = 60 * 60_000) => new Date(Date.now() - ms).toISOString();

function runAsync(args, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function installed(t, extraArgs = []) {
  const box = sandbox(t);
  const res = box.cli('init', '--yes', '--skill-targets', 'none', ...extraArgs);
  assert.equal(res.status, 0, res.stderr);
  return box;
}

test('B1: modelKeys computes transitive cycle-safe closure and resolveTarget/isBanned enforce aliases', (t) => {
  // Reversed key order and multi-hop chain plus cycle safety.
  const chained = {
    modelIds: { 'Opus Latest': 'claude-opus-5-5', 'Top Tier': 'Opus Latest', a: 'b', b: 'a' },
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', pool: 'standard', scarceQuota: false },
      { provider: 'claude', model: 'claude-fable-5-2', pool: 'fable', scarceQuota: true },
      { provider: 'codex', model: 'nova-7', pool: 'astra', scarceQuota: true },
    ],
  };
  assert.deepEqual([...modelKeys('Top Tier', chained)].sort(), ['claude-opus-5-5', 'opus-latest', 'top-tier']);
  assert.deepEqual([...modelKeys('a', chained)].sort(), ['a', 'b']);

  const resolved = resolveTarget({ model: 'Top Tier' }, chained);
  assert.equal(resolved.provider, 'claude');
  assert.equal(resolved.entry?.model, 'claude-opus-5-5');
  assert.equal(resolved.conflict, null);
  assert.match(resolveTarget({ providers: ['codex'], model: 'Top Tier' }, chained).conflict, /not hosted on provider codex/);

  // Custom non-prefixed model resolves provider and pool via config.models across alias closure.
  const customConfig = { ...chained, modelIds: { 'Nova Latest': 'nova-7' } };
  const custom = resolveTarget({ model: 'Nova Latest' }, customConfig);
  assert.equal(custom.provider, 'codex');
  assert.equal(custom.pool, 'astra');
  assert.equal(custom.scarceQuota, true);
  assert.equal(custom.crossHosted, false);

  assert.equal(isBanned('Top Tier', ['claude-opus-5-5'], chained), true);
  assert.equal(isBanned('Claude Opus 5.5', ['-'], chained), false);

  // End-to-end pre-tool-use checks with catalog.overrides.json aliases.
  const box = installed(t, ['--claude-tier', 'max']);
  const config = json(box.path(CONFIG_FILE));
  if (!config.allowlist.Claude.includes('Claude Fable 5.2')) config.allowlist.Claude.push('Claude Fable 5.2');
  if (!config.models.some((m) => m.model === 'claude-fable-5-2')) {
    config.models.push({ provider: 'claude', model: 'claude-fable-5-2', pool: 'fable', scarceQuota: true });
  }
  write(box.path(CONFIG_FILE), config);
  write(box.path(CATALOG_OVERRIDES_FILE), {
    aliases: {
      'Opus Latest': 'claude-opus-5-5',
      'Top Opus': 'Opus Latest',
      'Fable Latest': 'claude-fable-5-2',
    },
  });

  const call = (model) => box.hook('pre-tool-use', { tool_name: 'delegate_task', tool_input: { model } });
  assert.equal(call('Opus Latest').status, 0);
  assert.equal(call('Top Opus').status, 0);

  // 1) provider:claude lock blocks Opus Latest and chained Top Opus.
  writeCooldowns(box.path(COOLDOWN_FILE), {
    'provider:claude': { scope: 'provider', window: '5h', until: future(), reason: 'locked' },
  });
  assert.equal(call('Opus Latest').status, 2);
  assert.equal(call('Top Opus').status, 2);

  // 2) tier:claude:fable lock blocks Fable Latest while allowing Opus Latest.
  writeCooldowns(box.path(COOLDOWN_FILE), {
    'tier:claude:fable': { scope: 'tier', window: '5h', until: future(), reason: 'fable cap', tier: 'fable' },
  });
  assert.equal(call('Fable Latest').status, 2);
  assert.equal(call('Opus Latest').status, 0);
  writeCooldowns(box.path(COOLDOWN_FILE), {});

  // 3) plan-restricted availability mark blocks Opus Latest.
  writeAvailability(box.target, {
    checkedAt: new Date().toISOString(),
    ttlMs: 43_200_000,
    binaries: {},
    models: { 'claude:claude-opus-5-5': { status: 'plan-restricted', source: 'mark', until: future() } },
    discoveredNew: [],
    missingConfigured: [],
  });
  assert.equal(call('Opus Latest').status, 2);
  assert.equal(call('Top Opus').status, 2);
  fs.rmSync(box.path(AVAILABILITY_FILE), { force: true });

  // 4) userBannedModels blocks aliased target model.
  write(box.path(CONFIG_FILE), { ...config, userBannedModels: ['claude-opus-5-5'] });
  const banned = call('Opus Latest');
  assert.equal(banned.status, 2);
  assert.match(banned.stderr, /banned/);
});

test('B2: concurrent quota set and markAvailability preserve every write without leaking tmp/lock files', async (t) => {
  const box = installed(t);
  const subjects = [
    ['claude', '--burst'],
    ['codex', '--burst'],
    ['antigravity', '--burst'],
    ['claude-opus-5-5', '--burst'],
    ['gpt-6-luna', '--burst'],
    ['gemini-4-neon', '--burst'],
  ];
  const results = await Promise.all(subjects.map((args) => runAsync([CLI, 'quota', 'set', ...args], {
    cwd: box.dir, env: box.env,
  })));
  for (const res of results) assert.equal(res.status, 0, res.stderr);

  const stored = readCooldowns(box.path(COOLDOWN_FILE));
  for (const key of [
    'provider:claude', 'provider:codex', 'provider:antigravity',
    'model:claude-opus-5-5', 'model:gpt-6-luna', 'model:gemini-4-neon',
  ]) {
    assert.ok(stored[key], `missing concurrent lock ${key}`);
  }

  // Concurrent markAvailability writes preserve all marks.
  const refs = ['claude:claude-opus-5-5', 'codex:gpt-6-luna', 'antigravity:gemini-4-neon'];
  const markResults = await Promise.all(refs.map((ref) => runAsync([
    CLI, 'availability', 'mark', ref, 'unavailable', '--ttl', '24h',
  ], { cwd: box.dir, env: box.env })));
  for (const res of markResults) assert.equal(res.status, 0, res.stderr);
  const avail = readAvailabilityFile(box.target);
  for (const ref of refs) assert.equal(avail.models[ref]?.status, 'unavailable', `missing concurrent mark ${ref}`);

  // No stray .tmp, .lock, or .guard files remain.
  const stray = fs.readdirSync(box.target).filter((name) => /\.(tmp|lock|guard)$/.test(name) || name.includes('.lock.stale.'));
  assert.deepEqual(stray, []);
});

test('B2: session-start prunes under lock without wiping concurrent locks and never hangs on held lock', async (t) => {
  const box = installed(t);
  const cdFile = box.path(COOLDOWN_FILE);
  const lockFile = `${cdFile}.lock`;
  writeCooldowns(cdFile, {
    'model:old-model': { scope: 'model', window: 'burst', until: past(), reason: 'expired' },
  });

  // Hold the lock, launch session-start, then deterministically inject a concurrent writer right as session-start
  // collides with the held lock (after its initial readCooldowns, before updateCooldowns acquires the lock).
  fs.writeFileSync(lockFile, '999999\n');
  const hookScript = box.path('hooks', 't3-auto-build', 'session-start.mjs');
  const markerFile = box.path('contended.marker');
  const concurrentData = JSON.stringify({
    'model:old-model': { scope: 'model', window: 'burst', until: past(), reason: 'expired' },
    'provider:claude': { scope: 'provider', window: '5h', until: future(), reason: 'concurrent writer' },
  });
  const runner = `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const [hookFile, cdFile, lockFile, markerFile, concurrentJson] = process.argv.slice(1);
    const realOpen = fs.openSync;
    let injected = false;
    fs.openSync = function wrappedOpen(p, flags, mode) {
      if (!injected && p === lockFile && flags === 'wx') {
        try {
          return realOpen.call(this, p, flags, mode);
        } catch (err) {
          injected = true;
          fs.writeFileSync(cdFile, concurrentJson);
          fs.rmSync(lockFile, { force: true });
          fs.writeFileSync(markerFile, 'contended');
          throw err;
        }
      }
      return realOpen.call(this, p, flags, mode);
    };
    await import(pathToFileURL(hookFile).href);
  `;
  const result = await runAsync(
    ['--input-type=module', '-e', runner, hookScript, cdFile, lockFile, markerFile, concurrentData],
    { cwd: box.dir, env: box.env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(markerFile), true, 'expected deterministic lock contention before release');
  assert.doesNotMatch(result.stdout, /provider:claude/);
  const after = readCooldowns(cdFile);
  assert.equal(after['model:old-model'], undefined);
  assert.ok(after['provider:claude'], 'session-start must not wipe concurrent lock');

  // A continuously held fresh lock causes bounded wait, not a hang.
  writeCooldowns(cdFile, {
    'model:old-model': { scope: 'model', window: 'burst', until: past(), reason: 'expired' },
    'provider:codex': { scope: 'provider', window: '5h', until: future(), reason: 'still active' },
  });
  fs.writeFileSync(lockFile, '999999\n');
  t.after(() => fs.rmSync(lockFile, { force: true }));
  const started = Date.now();
  const held = await runAsync([hookScript], { cwd: box.dir, env: box.env });
  const elapsed = Date.now() - started;
  assert.equal(held.status, 0);
  assert.ok(elapsed < 3000, `session-start hung for ${elapsed}ms`);
  assert.match(held.stdout, /provider:codex/);
});

test('B2: stale lock recovery, retryBusy on rename, and temp cleanup on failure', (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const file = box.path('state.json');
  const lockFile = `${file}.lock`;

  // Stale lock recovery.
  fs.writeFileSync(lockFile, '12345\n');
  const staleAt = new Date(Date.now() - 30_000);
  fs.utimesSync(lockFile, staleAt, staleAt);
  const ran = withFileLock(file, () => 'recovered', { staleMs: 1000, timeoutMs: 500 });
  assert.equal(ran, 'recovered');
  assert.equal(fs.existsSync(lockFile), false);

  // Retry transient EBUSY/EPERM on renameSync.
  let attempts = 0;
  const realRename = fs.renameSync;
  const mockRetry = t.mock.method(fs, 'renameSync', (from, to) => {
    attempts += 1;
    if (attempts < 3) {
      const err = new Error('busy');
      err.code = attempts === 1 ? 'EBUSY' : 'EPERM';
      throw err;
    }
    return realRename(from, to);
  });
  writeFileAtomic(file, '{"ok":true}\n');
  mockRetry.mock.restore();
  assert.equal(attempts, 3);
  assert.deepEqual(json(file), { ok: true });

  // Permanent rename failure cleans up temp file in finally.
  const mockFail = t.mock.method(fs, 'renameSync', () => {
    const err = new Error('denied');
    err.code = 'EPERM';
    throw err;
  });
  assert.throws(() => writeFileAtomic(file, '{"fail":true}\n'), { code: 'EPERM' });
  mockFail.mock.restore();
  assert.deepEqual(fs.readdirSync(box.target).filter((name) => name.endsWith('.tmp')), []);
});

test('B3: v1 heavy-tier-only quota set claude --5h writes tier:claude:heavy and blocks heavy models', (t) => {
  const box = installed(t);
  // Downgrade config to v1 with claude:max (heavy-tier-only).
  write(box.path(CONFIG_FILE), {
    allowlist: {
      Claude: ['Claude Haiku 5.5', 'Claude Sonnet 5.5', 'Claude Opus 5.5'],
    },
    bannedModels: [],
    tiers: {
      claude: { plan: 'max', sharing: 'heavy-tier-only', heavyModels: ['Claude Opus 5.5'] },
    },
  });

  const now = Date.now();
  const lock = quotaSet(box.target, 'claude', { window: '5h', now, log: () => {} });
  assert.equal(lock.key, 'tier:claude:heavy');
  assert.equal(lock.entry.tier, 'heavy');

  const heavy = box.hook('pre-tool-use', { tool_name: 'delegate_task', tool_input: { model: 'Claude Opus 5.5' } });
  assert.equal(heavy.status, 2, heavy.stderr);
  assert.match(heavy.stderr, /tier:claude:heavy/);

  const standard = box.hook('pre-tool-use', { tool_name: 'delegate_task', tool_input: { model: 'Claude Sonnet 5.5' } });
  assert.equal(standard.status, 0, standard.stderr);
});

const SHARED_URL = pathToFileURL(path.join(ROOT, 'hooks', '_shared.mjs')).href;

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test('A: aged stale lock reclaimed safely across 8 concurrent child processes incrementing a counter', async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const counterFile = box.path('counter.txt');
  const lockFile = `${counterFile}.lock`;
  fs.writeFileSync(counterFile, '0\n');
  fs.writeFileSync(lockFile, '999999:stale\n');
  const staleAt = new Date(Date.now() - 30_000);
  fs.utimesSync(lockFile, staleAt, staleAt);

  const worker = `
    import fs from 'node:fs';
    import { withFileLock } from ${JSON.stringify(SHARED_URL)};
    const file = process.argv[1];
    withFileLock(file, () => {
      const n = Number(fs.readFileSync(file, 'utf8').trim());
      fs.writeFileSync(file, String(n + 1) + '\\n');
    }, { timeoutMs: 10_000, staleMs: 2000, pollMs: 10 });
  `;
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    runAsync(['--input-type=module', '-e', worker, counterFile], { cwd: box.dir, env: box.env })));
  for (const res of results) assert.equal(res.status, 0, res.stderr);
  assert.equal(Number(fs.readFileSync(counterFile, 'utf8').trim()), 8);

  const stray = fs.readdirSync(box.target).filter((name) => /\.(lock|guard)$/.test(name));
  assert.deepEqual(stray, []);
});

test('A: holder past tiny staleMs leaves successor lock intact in finally', async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const file = box.path('shared.json');
  const lockFile = `${file}.lock`;
  const guardFile = `${lockFile}.guard`;
  const holderReady = box.path('holder.ready');
  const releaseHolder = box.path('holder.release');
  const successorReady = box.path('successor.ready');
  const releaseSuccessor = box.path('successor.release');

  const holderScript = `
    import fs from 'node:fs';
    import { withFileLock } from ${JSON.stringify(SHARED_URL)};
    const [file, readyFile, releaseFile] = process.argv.slice(1);
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    withFileLock(file, () => {
      fs.writeFileSync(readyFile, 'ready');
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(waitBuf, 0, 0, 10);
    }, { staleMs: 30, timeoutMs: 2000, pollMs: 10 });
  `;
  const successorScript = `
    import fs from 'node:fs';
    import { withFileLock } from ${JSON.stringify(SHARED_URL)};
    const [file, readyFile, releaseFile] = process.argv.slice(1);
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    withFileLock(file, () => {
      fs.writeFileSync(readyFile, fs.readFileSync(file + '.lock', 'utf8'));
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(waitBuf, 0, 0, 10);
    }, { staleMs: 30, timeoutMs: 5000, pollMs: 10 });
  `;

  const holder = runAsync(['--input-type=module', '-e', holderScript, file, holderReady, releaseHolder], {
    cwd: box.dir, env: box.env,
  });
  await waitForFile(holderReady);
  // Let the holder's lock age past staleMs (30ms) so the successor reclaims it.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const successor = runAsync(['--input-type=module', '-e', successorScript, file, successorReady, releaseSuccessor], {
    cwd: box.dir, env: box.env,
  });
  await waitForFile(successorReady);
  const successorToken = fs.readFileSync(successorReady, 'utf8');

  // Let the original holder finish and run its finally block while successor still holds the lock.
  fs.writeFileSync(releaseHolder, 'go');
  const holderRes = await holder;
  assert.equal(holderRes.status, 0, holderRes.stderr);

  assert.equal(fs.existsSync(lockFile), true, 'holder finally must not remove successor lock');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), successorToken);

  fs.writeFileSync(releaseSuccessor, 'go');
  const successorRes = await successor;
  assert.equal(successorRes.status, 0, successorRes.stderr);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.existsSync(guardFile), false);
});

test('A: release retries when guard is briefly busy instead of leaking lock', async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const file = box.path('busy-guard.json');
  const lockFile = `${file}.lock`;
  const guardFile = `${lockFile}.guard`;
  const readyFile = box.path('ready');
  const goFile = box.path('go');

  const script = `
    import fs from 'node:fs';
    import { withFileLock } from ${JSON.stringify(SHARED_URL)};
    const [file, readyFile, goFile] = process.argv.slice(1);
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    withFileLock(file, () => {
      fs.writeFileSync(readyFile, '1');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(goFile) && Date.now() < deadline) Atomics.wait(waitBuf, 0, 0, 5);
    }, { timeoutMs: 2000, pollMs: 10 });
  `;
  const child = runAsync(['--input-type=module', '-e', script, file, readyFile, goFile], {
    cwd: box.dir, env: box.env,
  });
  await waitForFile(readyFile);
  fs.writeFileSync(guardFile, '999999:busy\n');
  fs.writeFileSync(goFile, '1');
  await new Promise((resolve) => setTimeout(resolve, 80));
  fs.rmSync(guardFile, { force: true });

  const res = await child;
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(lockFile), false, 'release must retry busy guard and remove lock');
  assert.equal(fs.existsSync(guardFile), false);
});

test('B: non-regular lock or guard path throws ELOCKED immediately', (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });
  const dirLocked = box.path('dir-target.json');
  fs.mkdirSync(`${dirLocked}.lock`);
  let ran = false;
  const t0 = Date.now();
  assert.throws(() => withFileLock(dirLocked, () => { ran = true; }, { timeoutMs: 5000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(ran, false);

  // Non-regular guard path with NO lock file throws ELOCKED immediately without creating .lock or running action.
  const guardOnly = box.path('guard-only.json');
  fs.mkdirSync(`${guardOnly}.lock.guard`);
  const tGuardOnly = Date.now();
  assert.throws(() => withFileLock(guardOnly, () => { ran = true; }, { timeoutMs: 5000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - tGuardOnly < 1000);
  assert.equal(ran, false);
  assert.equal(fs.existsSync(`${guardOnly}.lock`), false, 'must not leave .lock behind when guard is non-regular');

  // Non-regular guard path during stale reclaim also throws ELOCKED immediately.
  const guardBlocked = box.path('guard-target.json');
  fs.writeFileSync(`${guardBlocked}.lock`, '12345:old\n');
  const staleAt = new Date(Date.now() - 30_000);
  fs.utimesSync(`${guardBlocked}.lock`, staleAt, staleAt);
  fs.mkdirSync(`${guardBlocked}.lock.guard`);
  const t1 = Date.now();
  assert.throws(() => withFileLock(guardBlocked, () => { ran = true; }, { timeoutMs: 5000, staleMs: 1000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - t1 < 1000);
  assert.equal(ran, false);

  // Guard becoming a directory during action releases .lock without hanging or leaking.
  const midAction = box.path('mid-action-guard.json');
  const t2 = Date.now();
  const out = withFileLock(midAction, () => {
    fs.mkdirSync(`${midAction}.lock.guard`);
    return 'done';
  }, { timeoutMs: 5000 });
  assert.equal(out, 'done');
  assert.ok(Date.now() - t2 < 1000);
  assert.equal(fs.existsSync(`${midAction}.lock`), false, 'must not leak .lock when guard becomes directory during action');

  // Guard becoming a directory during a throwing action still releases .lock and propagates action error.
  const midThrow = box.path('mid-throw-guard.json');
  const t3 = Date.now();
  assert.throws(() => withFileLock(midThrow, () => {
    fs.mkdirSync(`${midThrow}.lock.guard`);
    throw new Error('action failed');
  }, { timeoutMs: 5000 }), /action failed/);
  assert.ok(Date.now() - t3 < 1000);
  assert.equal(fs.existsSync(`${midThrow}.lock`), false);
});

function makeDanglingLink(targetPath, linkPath) {
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    fs.mkdirSync(targetPath);
    fs.symlinkSync(targetPath, linkPath, 'junction');
    fs.rmdirSync(targetPath);
  }
}

test('B: dangling symlink or junction at <file>.lock and .guard throws ELOCKED without recreating target', (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.target, { recursive: true });

  // 1) Dangling symlink/junction at <file>.lock.
  const file = box.path('dangling.json');
  const victimLock = box.path('victim-lock');
  makeDanglingLink(victimLock, `${file}.lock`);
  const started = Date.now();
  assert.throws(() => withFileLock(file, () => 'nope', { timeoutMs: 5000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - started < 1000, `expected <1s, took ${Date.now() - started}ms`);
  assert.equal(fs.existsSync(victimLock), false, 'dangling lock target must not be recreated');

  // 2) Dangling symlink/junction at <file>.lock.guard with NO <file>.lock.
  const guardOnly = box.path('dangling-guard-only.json');
  const victimGuardOnly = box.path('victim-guard-only');
  makeDanglingLink(victimGuardOnly, `${guardOnly}.lock.guard`);
  let ranGuardOnly = false;
  const tGuardOnly = Date.now();
  assert.throws(() => withFileLock(guardOnly, () => { ranGuardOnly = true; }, { timeoutMs: 5000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - tGuardOnly < 1000, `expected <1s, took ${Date.now() - tGuardOnly}ms`);
  assert.equal(ranGuardOnly, false);
  assert.equal(fs.existsSync(`${guardOnly}.lock`), false, 'must not leave .lock behind');
  assert.equal(fs.existsSync(victimGuardOnly), false, 'dangling guard target must not be recreated');

  // 3) Dangling symlink/junction at <file>.lock.guard during stale reclaim.
  const guardTarget = box.path('dangling-guard.json');
  const victimGuard = box.path('victim-guard');
  fs.writeFileSync(`${guardTarget}.lock`, '12345:stale\n');
  const staleAt = new Date(Date.now() - 30_000);
  fs.utimesSync(`${guardTarget}.lock`, staleAt, staleAt);
  makeDanglingLink(victimGuard, `${guardTarget}.lock.guard`);
  const tGuard = Date.now();
  assert.throws(() => withFileLock(guardTarget, () => 'nope', { timeoutMs: 5000, staleMs: 1000 }), { code: 'ELOCKED' });
  assert.ok(Date.now() - tGuard < 1000, `expected <1s, took ${Date.now() - tGuard}ms`);
  assert.equal(fs.existsSync(victimGuard), false, 'dangling guard target must not be recreated');

  // 4) Dangling symlink/junction at <file>.lock.guard during release (finally) does not recreate target or leak .lock.
  const releaseTarget = box.path('dangling-release.json');
  const victimRelease = box.path('victim-release');
  const tRelease = Date.now();
  const out = withFileLock(releaseTarget, () => {
    makeDanglingLink(victimRelease, `${releaseTarget}.lock.guard`);
    return 'ok';
  }, { timeoutMs: 1000 });
  assert.equal(out, 'ok');
  assert.ok(Date.now() - tRelease < 1000, `expected <1s, took ${Date.now() - tRelease}ms`);
  assert.equal(fs.existsSync(`${releaseTarget}.lock`), false, 'dangling release guard must not leak .lock');
  assert.equal(fs.existsSync(victimRelease), false, 'dangling release guard target must not be recreated');
});

test('B: quota clear --all recovers when .lock.guard is a directory or symlink/junction without leaving .lock', (t) => {
  const box = installed(t);
  const cdFile = box.path(COOLDOWN_FILE);
  const cdLock = `${cdFile}.lock`;
  const cdGuard = `${cdLock}.guard`;

  // (a) Empty .lock.guard directory: cleared and empty guard dir cleaned up.
  write(cdFile, '{ corrupt');
  fs.mkdirSync(cdGuard);
  const emptyLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => emptyLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.equal(fs.existsSync(cdGuard), false);
  assert.match(emptyLogs.join('\n'), /warning:.*auto-build-cooldowns\.json\.lock\.guard/);

  // (b) Non-empty .lock.guard directory: cooldown cleared, guard contents preserved, no .lock left.
  write(cdFile, '{ corrupt');
  const keepFile = path.join(cdGuard, 'keep.txt');
  write(keepFile, 'KEEP');
  quotaClear(box.target, { all: true }, { log: () => {} });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.equal(fs.readFileSync(keepFile, 'utf8'), 'KEEP');
  fs.rmSync(cdGuard, { recursive: true, force: true });

  // (c) Dangling symlink/junction at .lock.guard: cooldown cleared, link target not recreated, no .lock left.
  write(cdFile, '{ corrupt');
  const victim = box.path('victim-clear-guard');
  makeDanglingLink(victim, cdGuard);
  quotaClear(box.target, { all: true }, { log: () => {} });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.equal(fs.existsSync(victim), false);
  fs.rmSync(cdGuard, { force: true });
});

test('D: dated userBannedModels matches stripped key exactly without over-banning sibling versions', (t) => {
  const cfg = { modelIds: { 'Opus Pinned': 'claude-opus-5-5-20260101' } };
  assert.equal(isBanned('Opus Pinned', ['claude-opus-5-5-20260101'], cfg), true);
  assert.equal(isBanned('Claude Opus 5.5', ['claude-opus-5-5-20260101'], cfg), true);
  assert.equal(isBanned('claude-sonnet-4', ['claude-sonnet-4-20250514'], cfg), true);
  assert.equal(isBanned('claude-sonnet-4-5', ['claude-sonnet-4-20250514'], cfg), false);
  assert.equal(isBanned('Claude Sonnet 4.5', ['claude-sonnet-4-20250514'], cfg), false);
  assert.equal(isBanned('Claude Opus 5.5', ['-20260101'], cfg), false);
  assert.equal(isBanned('Claude Opus 5.5', ['---20260101'], cfg), false);

  const box = installed(t, ['--claude-tier', 'max']);
  const config = json(box.path(CONFIG_FILE));
  config.allowlist.Claude = [...new Set([...config.allowlist.Claude, 'claude-sonnet-4-5'])];
  config.models = [...(config.models ?? []), { provider: 'claude', model: 'claude-sonnet-4-5', pool: 'standard', scarceQuota: false }];
  write(box.path(CONFIG_FILE), { ...config, userBannedModels: ['claude-opus-5-5-20260101', 'claude-sonnet-4-20250514'] });
  write(box.path(CATALOG_OVERRIDES_FILE), {
    aliases: { 'Opus Pinned': 'claude-opus-5-5-20260101' },
  });

  const banned = box.hook('pre-tool-use', { tool_name: 'delegate_task', tool_input: { model: 'Opus Pinned' } });
  assert.equal(banned.status, 2, banned.stderr);
  assert.match(banned.stderr, /banned/);

  const sibling = box.hook('pre-tool-use', { tool_name: 'delegate_task', tool_input: { model: 'claude-sonnet-4-5' } });
  assert.equal(sibling.status, 0, sibling.stderr);
});

test('E: pre-tool-use strips NTFS streams before secret match without breaking drive letters', (t) => {
  const box = installed(t);
  const edit = (file_path, tool_name = 'Write') => box.hook('pre-tool-use', { tool_name, tool_input: { file_path } });
  for (const secret of [
    'C:/p/.env::$DATA', 'C:\\p\\.env::$DATA', 'x.pem::$DATA', '.env:stream',
    'C:/p/.env.local:hidden', 'C:.env::$DATA', 'C:/p/server.key::$DATA', 'x.pem::$DATA\n',
  ]) {
    const res = edit(secret);
    assert.equal(res.status, 2, `${secret}: ${res.stderr}`);
    assert.match(res.stderr, /secret\/credential/);
  }
  for (const safe of ['C:/p/src/env.js', 'C:\\p\\README.md', 'C:/p/a.pem.md::$DATA', 'C:notes.txt']) {
    const res = edit(safe);
    assert.equal(res.status, 0, `${safe}: ${res.stderr}`);
  }
});

test('F: rm brace lists/bare vars and git global options/+refspec are blocked without false positives', (t) => {
  const box = installed(t);
  const bash = (command) => box.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command } });

  const blocked = [
    'rm -rf {~,x}', 'rm -rf {..,x}', 'rm -rf build/{a,b}', 'rm -rf {{a},b}',
    'rm -rf $VAR', 'rm -rf "$VAR"', "rm -rf '$VAR'", 'rm -rf ${VAR}', 'rm -rf "${VAR}"',
    'rm -rf $VAR/', 'rm -rf ./$VAR', 'rm -rf $env:TARGET', 'rm -rf %TARGET%',
    'git -C . push -f', 'git -C /tmp/repo push --force', 'git -c a=b reset --hard',
    'git --git-dir=.git --work-tree=. reset --hard', 'git --no-pager -C . push -f',
    'git push origin +main', 'git push origin +HEAD:main', 'git push origin "+refs/heads/main"',
    'git -C . push -u origin main +dev', 'git push -uf origin main', 'git push --repo=origin +main',
  ];
  for (const cmd of blocked) {
    const res = bash(cmd);
    assert.equal(res.status, 2, `${cmd}: ${res.stderr}`);
    assert.match(res.stderr, /destructive command/);
  }

  const allowed = [
    'rm -rf build', 'rm -rf $TMPDIR/x', 'rm -rf "${TMPDIR}/x"', 'rm -rf build/$NAME', 'rm -rf build/a,b',
    'git -C . status', 'git -c a=b status --hard', 'git push origin main',
    'git push origin feature+1', 'git push -o foo=+bar origin main', 'git -C . reset --soft HEAD~1',
    'git push origin main\necho --force',
  ];
  for (const cmd of allowed) {
    const res = bash(cmd);
    assert.equal(res.status, 0, `${cmd}: ${res.stderr}`);
  }
});

test('G: delegate_task blocks non-object target and validates model options in array and object forms', (t) => {
  const box = installed(t);
  const delegate = (tool_input) => box.hook('pre-tool-use', { tool_name: 'mcp__t3-code__delegate_task', tool_input });

  for (const badTarget of [[], ['gpt-4'], 'gpt-4', null, 42]) {
    const res = delegate({ task: 'x', target: badTarget });
    assert.equal(res.status, 2, `target=${JSON.stringify(badTarget)}: ${res.stderr}`);
    assert.match(res.stderr, /target.*not an object/);
  }

  for (const badInput of [
    { target: { options: [{ id: 'model', value: 'gpt-4' }] } },
    { target: { options: { model: 'gpt-4' } } },
    { options: [{ id: 'model', value: 'gpt-4' }] },
    { options: { model: 'gpt-4' } },
    { target: { model: 'claude-sonnet-5-5', options: [{ id: 'Model', value: 'gpt-5.4' }] } },
  ]) {
    const res = delegate(badInput);
    assert.equal(res.status, 2, `${JSON.stringify(badInput)}: ${res.stderr}`);
    assert.match(res.stderr, /allowlist|retired|banned/);
  }

  for (const goodInput of [
    {},
    { model: 'Claude Opus 5.5' },
    { target: { options: [{ id: 'model', value: 'claude-sonnet-5-5' }] } },
    { target: { options: { model: 'claude-sonnet-5-5' } } },
    { target: { options: [{ id: 'effort', value: 'high' }] } },
  ]) {
    const res = delegate(goodInput);
    assert.equal(res.status, 0, `${JSON.stringify(goodInput)}: ${res.stderr}`);
  }
  assert.equal(box.hook('pre-tool-use', { tool_name: 'mcp__t3-code__delegate_task' }).status, 0);
});

test('H: readPayload 8 MiB cap blocks pre-tool-use and fails open in non-guard hooks', async (t) => {
  const box = installed(t);
  const oversized = `{"tool_name":"Read","tool_input":{"data":"${'a'.repeat(8 * 1024 * 1024 + 1024)}"}}`;

  const pre = await runAsync([box.path('hooks', 't3-auto-build', 'pre-tool-use.mjs')], {
    cwd: box.dir, env: box.env, input: oversized,
  });
  assert.equal(pre.status, 2, pre.stderr);
  assert.match(pre.stderr, /exceeded/i);

  for (const hookName of ['post-tool-use', 'pre-compact']) {
    const res = await runAsync([box.path('hooks', 't3-auto-build', `${hookName}.mjs`)], {
      cwd: box.dir, env: { ...box.env, GIT_CEILING_DIRECTORIES: box.dir }, input: oversized,
    });
    assert.equal(res.status, 0, `${hookName}: ${res.stderr}`);
    assert.match(res.stderr, /oversized/i, hookName);
  }
});

const QUOTA_URL = pathToFileURL(path.join(ROOT, 'hooks', '_quota.mjs')).href;

test('I: parseRateLimit local clock time does not shift 1h across DST spring-forward or fall-back', async (t) => {
  const box = sandbox(t);
  const script = `
    import assert from 'node:assert/strict';
    import { parseRateLimit } from ${JSON.stringify(QUOTA_URL)};
    // 2026-03-08 is US spring-forward (02:00 -> 03:00). At 10:00 EDT, "resets 2:30am" must be 2026-03-09 02:30 EDT (06:30Z), not 03:30 EDT.
    const spring = parseRateLimit('resets 2:30am', { now: Date.parse('2026-03-08T14:00:00Z') });
    assert.equal(spring.until, '2026-03-09T06:30:00.000Z');
    // Evening before spring-forward: 2026-03-07 15:00 EST, "resets 2pm" -> 2026-03-08 14:00 EDT (18:00Z).
    const eve = parseRateLimit('resets 2pm', { now: Date.parse('2026-03-07T20:00:00Z') });
    assert.equal(eve.until, '2026-03-08T18:00:00.000Z');
    // 2026-11-01 is US fall-back. At 10:00 EST, "resets 1:30am" -> 2026-11-02 01:30 EST (06:30Z).
    const fall = parseRateLimit('resets 1:30am', { now: Date.parse('2026-11-01T15:00:00Z') });
    assert.equal(fall.until, '2026-11-02T06:30:00.000Z');
  `;
  const res = await runAsync(['--input-type=module', '-e', script], {
    cwd: box.dir, env: { ...box.env, TZ: 'America/New_York' },
  });
  assert.equal(res.status, 0, res.stderr);
});

test('NIT 5: two-arg isBanned matches date-stripped model without over-banning sibling versions', () => {
  assert.equal(isBanned('claude-sonnet-4-20250999', ['claude-sonnet-4-20250514']), true);
  assert.equal(isBanned('claude-sonnet-4', ['claude-sonnet-4-20250514']), true);
  assert.equal(isBanned('claude-sonnet-4-5', ['claude-sonnet-4-20250514']), false);
  assert.equal(isBanned('claude-sonnet-4-5-20250999', ['claude-sonnet-4-20250514']), false);
});

test('NIT 6: rm brace rule blocks all brace-list targets including quoted and nested/eval forms', (t) => {
  const box = installed(t);
  const bash = (command) => box.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command } });

  for (const cmd of [
    "rm -rf 'dir{1,2}'",
    'rm -rf "dir{1,2}"',
    'echo "ok" && rm -rf \'dir{1,2}\'',
    'rm -rf {~,x}',
    'rm -rf "x"{~,y}',
    "rm -rf 'x'{~,y}",
    'rm -rf \'dir{1,2}"',
    'rm -rf "dir{1,2}',
    'rm -rf \'a{b,\'c}',
    'bash -c "rm -rf "{~,x}" ; true"',
    "bash -c 'rm -rf '{~,x}' ; true'",
    "eval rm -rf '{~,x}'",
    "sh -c rm' -rf '{~,x}' '",
    ": $'\\'' && bash -c 'rm -rf '{~,x}' '",
    "# '\nbash -c 'rm -rf '{~,x}' '",
  ]) {
    const res = bash(cmd);
    assert.equal(res.status, 2, `${cmd}: ${res.stderr}`);
    assert.match(res.stderr, /destructive command/);
  }
});

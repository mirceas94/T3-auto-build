import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_FILE, COOLDOWN_FILE, QUOTA_FILE, loadConfig, withFileLock,
} from '../hooks/_shared.mjs';
import {
  MAX_LOCK, isLocked, parseRateLimit, prune, readCooldowns, summarize, updateCooldowns, writeCooldowns,
} from '../hooks/_quota.mjs';
import { rpcRunner } from '../lib/discover/sources.mjs';
import { completeConfig, configProblem, upgrade } from '../lib/install.mjs';
import {
  applicableWindows, applyQuotaLocks, isProviderFresh, lockKeyForWindow, paceScore, parseAntigravityUsage,
  parseClaudeUsage, parseCodexRateLimits, readProviderQuota, readQuotaCache, refreshQuota, sanitizeWindow,
} from '../lib/quota/usage.mjs';
import { CliError } from '../lib/paths.mjs';
import { countdown, quotaCheck, quotaClear, quotaSet, quotaStatus } from '../lib/quota.mjs';
import { sandbox, json, write } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 26, 12);
const after = (ms) => new Date(NOW + ms).toISOString();

test('cooldown storage reads legacy entries and bare model keys, then writes canonical entries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-quota-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cooldowns.json');
  write(file, { 'claude-opus-5-5': { until_utc: after(60_000), scope: 'model' }, 'provider:codex': { until: after(120_000), scope: 'provider' } });
  const data = readCooldowns(file);
  assert.equal(data['claude-opus-5-5'].scope, 'model');
  assert.equal(data['claude-opus-5-5'].window, 'custom');
  assert.equal(data['claude-opus-5-5'].until, after(60_000));
  assert.equal(data['provider:codex'].source, 'manual');
  writeCooldowns(file, data);
  assert.deepEqual(readCooldowns(file), data);
});

test('prune, isLocked, and summarize honor expiry, provider/model/tier keys and heavy models', () => {
  const data = {
    'model:claude-opus-5-5': { scope: 'model', window: 'burst', until: after(60_000), reason: 'busy' },
    'provider:codex': { scope: 'provider', window: 'weekly', until: after(120_000), reason: 'weekly' },
    'tier:claude:heavy': { scope: 'tier', window: '5h', until: after(180_000), reason: 'cap' },
    expired: { scope: 'model', until: after(-1), reason: 'old' },
  };
  const split = prune(data, NOW);
  assert.deepEqual(Object.keys(split.kept), ['model:claude-opus-5-5', 'provider:codex', 'tier:claude:heavy']);
  assert.deepEqual(Object.keys(split.removed), ['expired']);
  assert.equal(isLocked(data, { model: 'claude-sonnet-5-5' }, NOW), null);
  assert.equal(isLocked(data, { model: 'gpt-6-luna' }, NOW).scope, 'provider');
  assert.equal(isLocked(data, { model: 'claude-opus-5-5' }, NOW).scope, 'tier');
  assert.equal(isLocked(data, { provider: 'codex', model: 'gpt-6-luna' }, NOW).key, 'provider:codex');
  const summary = summarize(data, NOW);
  assert.ok(summary.length <= 3);
  assert.ok(summary.join('\n').includes('weekly'));
  assert.deepEqual(summarize({}, NOW), []);
});

test('v2 cooldown keys distinguish model identity, hosting, provider aliases, and tier pools', (t) => {
  const lock = (key) => ({ [key]: { scope: key.split(':', 1)[0], window: '5h', until: after(60_000), reason: 'test' } });
  const config = {
    models: [
      { provider: 'claude', model: 'claude-sonnet-5-5', pool: 'standard', scarceQuota: false },
      { provider: 'claude', model: 'claude-opus-5-5', pool: 'standard', scarceQuota: false },
      { provider: 'claude', model: 'claude-fable-5-2', pool: 'fable', scarceQuota: true },
      { provider: 'codex', model: 'gpt-6-astra', pool: 'astra', scarceQuota: true },
      { provider: 'antigravity', model: 'claude-opus-5-5', pool: 'third-party-claude', scarceQuota: true },
      { provider: 'antigravity', model: 'claude-sonnet-5-5', pool: 'third-party-claude', scarceQuota: true },
    ],
  };
  const hit = (key, request, cfg = config) => isLocked(lock(key), { ...request, config: cfg }, NOW)?.key ?? null;

  assert.equal(hit('provider:work', { provider: 'work', model: 'my-model' }), 'provider:work');
  assert.equal(hit('provider:codex-2', { provider: 'codex', model: 'gpt-6-luna' }), null);
  assert.equal(hit('provider:codex', { provider: 'unknown-custom', model: 'gpt-6-luna' }), 'provider:codex');
  assert.equal(hit('provider:claude', { providers: ['antigravity'], model: 'claude-opus-5-5' }), null);
  assert.equal(hit('tier:antigravity:third-party-claude', { providers: ['antigravity'], model: 'claude-opus-5-5' }), 'tier:antigravity:third-party-claude');
  assert.equal(hit('provider:codex', { provider: 'codex', model: 'claude-sonnet-5-5' }), 'provider:codex');
  assert.equal(hit('provider:claude', { provider: 'codex', model: 'claude-sonnet-5-5' }), 'provider:claude');

  assert.equal(hit('model:antigravity:claude-sonnet-5-5', { model: 'claude-sonnet-5-5' }), null);
  assert.equal(hit('model:claude:claude-sonnet-5-5', { model: 'claude-sonnet-5-5' }), 'model:claude:claude-sonnet-5-5');
  assert.equal(hit('model:claudeAgent:claude-sonnet-5-5', { model: 'claude-sonnet-5-5' }), 'model:claudeAgent:claude-sonnet-5-5');
  assert.equal(hit('model:codex-2:gpt-6-luna', { provider: 'codex', model: 'gpt-6-luna' }), null);
  assert.equal(hit('model:codex-2:gpt-6-luna', { provider: 'codex-2', model: 'gpt-6-luna' }), 'model:codex-2:gpt-6-luna');
  assert.equal(hit('model:claude-sonnet-5-5', { model: 'claude-sonnet-5-5' }), 'model:claude-sonnet-5-5');
  assert.equal(hit('model:claude-sonnet-5-5', { providers: ['antigravity'], model: 'claude-sonnet-5-5' }), 'model:claude-sonnet-5-5');

  const legacy = lock('tier:claude:heavy');
  assert.equal(isLocked(legacy, { model: 'claude-opus-5-5', config }, NOW)?.key, 'tier:claude:heavy');
  assert.equal(isLocked(legacy, { model: 'claude-fable-5-2', config }, NOW)?.key, 'tier:claude:heavy');
  assert.equal(isLocked(lock('tier:codex:heavy'), { model: 'gpt-6-astra', config }, NOW)?.key, 'tier:codex:heavy');
  assert.equal(hit('tier:claudeAgent:heavy', { model: 'claude-opus-5-5' }), 'tier:claudeAgent:heavy');
  assert.equal(hit('tier:claudeAgent:heavy', { model: 'claude-fable-5-2' }), 'tier:claudeAgent:heavy');
  assert.equal(hit('tier:claude:heavy', { providers: ['antigravity'], model: 'claude-opus-5-5' }), null);
  assert.equal(hit('tier:codex-2:astra', { provider: 'codex', model: 'gpt-6-astra' }), null);
  assert.equal(hit('tier:codex-2:astra', { provider: 'codex-2', model: 'gpt-6-astra' }), 'tier:codex-2:astra');
  assert.equal(hit('tier:codex-2:astra', { provider: 'codex-2', model: 'gpt-6-luna' }), null);
  assert.ok(summarize(lock('tier:antigravity:third-party-claude'), NOW).join('\n').includes('third-party-claude'));
});

test('cooldown validation accepts provider-qualified models and pool tier keys', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-quota-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cooldowns.json');
  write(file, {
    'model:antigravity:claude-sonnet-5-5': { scope: 'model', until: after(60_000) },
    'tier:codex:third-party-claude': { scope: 'tier', until: after(60_000) },
    'tier:codex:bad_pool': { scope: 'tier', until: after(60_000) },
  });
  assert.deepEqual(Object.keys(readCooldowns(file, () => {})), [
    'model:antigravity:claude-sonnet-5-5', 'tier:codex:third-party-claude',
  ]);
});

test('rate limit parsing handles burst retry, 5h, weekly reset, and heavy-tier sharing', () => {
  assert.deepEqual(parseRateLimit('429 Too Many Requests', { now: NOW, retryAfter: '30' }), {
    window: 'burst', scope: 'model', until: after(30_000),
  });
  assert.deepEqual(parseRateLimit('5-hour limit', { now: NOW, sharing: 'heavy-tier-only' }), {
    window: '5h', scope: 'tier', until: after(5 * 60 * 60_000),
  });
  assert.deepEqual(parseRateLimit('5h limit', { now: NOW, sharing: 'provider' }), {
    window: '5h', scope: 'provider', until: after(5 * 60 * 60_000),
  });
  assert.deepEqual(parseRateLimit('Weekly limit reached, resets Monday', { now: NOW }), {
    window: 'weekly', scope: 'provider', until: '2026-11-30T00:00:00.000Z',
  });
  assert.deepEqual(parseRateLimit('weekly limit', { now: NOW, resetDay: 'friday' }), {
    window: 'weekly', scope: 'provider', until: '2026-11-27T00:00:00.000Z',
  });
  assert.deepEqual(parseRateLimit('Usage limit reached. Resets at 15:00 UTC', { now: Date.UTC(2026, 10, 26, 14, 0, 0) }), {
    window: '5h', scope: 'provider', until: '2026-11-26T15:00:00.000Z',
  });
  assert.deepEqual(parseRateLimit('Resets at 3pm GMT', { now: Date.UTC(2026, 10, 26, 16, 0, 0) }), {
    window: '5h', scope: 'provider', until: '2026-11-27T15:00:00.000Z',
  });
  assert.deepEqual(parseRateLimit('Try again at 15:30Z', { now: Date.UTC(2026, 10, 26, 14, 0, 0) }), {
    window: '5h', scope: 'provider', until: '2026-11-26T15:30:00.000Z',
  });
  assert.deepEqual(parseRateLimit('429 error, resets at 25:99', { now: NOW }), {
    window: 'burst', scope: 'model', until: after(10 * 60_000),
  });
});

test('countdown handles NaN, zero, negative, and positive durations', () => {
  assert.equal(countdown(NaN), 'unknown');
  assert.equal(countdown(Infinity), 'unknown');
  assert.equal(countdown(0), '0s');
  assert.equal(countdown(-1000), '0s');
  assert.equal(countdown(65_000), '1m 5s');
});

test('quota set/status/clear persist locks and status prunes expired entries', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const logs = [];
  const model = quotaSet(box.target, 'gpt-6-luna', { window: 'burst', now: NOW, reason: 'manual test', log: (line) => logs.push(line) });
  assert.equal(model.key, 'model:gpt-6-luna');
  assert.equal(model.entry.window, 'burst');
  assert.equal(readCooldowns(box.path('auto-build-cooldowns.json'))[model.key].reason, 'manual test');
  const provider = quotaSet(box.target, 'claude', { window: '5h', now: NOW });
  assert.equal(provider.key, 'provider:claude');
  const status = quotaStatus(box.target, { now: NOW, log: (line) => logs.push(line) });
  assert.equal(status.length, 2);
  assert.ok(logs.some((line) => line.includes('left, resets')));

  // Expiry is evaluated and persisted by status.
  const file = box.path('auto-build-cooldowns.json');
  write(file, { old: { scope: 'model', window: 'custom', until: after(-1000), reason: 'old', source: 'manual' } });
  assert.deepEqual(quotaStatus(box.target, { now: NOW, log: () => {} }), []);
  assert.deepEqual(readCooldowns(file), {});

  quotaSet(box.target, 'claude', { until: after(60_000), now: NOW, log: () => {} });
  assert.deepEqual(quotaClear(box.target, 'claude', { log: () => {} }), ['provider:claude']);
  quotaClear(box.target, { all: true }, { log: () => {} });
  assert.deepEqual(readCooldowns(file), {});
});

test('codex JSON-RPC reader handles 300/10080/43200 windows, null secondary, astra pool, strips accountId, and handles timeout', async (t) => {
  const sent = [];
  const fakeRpc = async (cmd, args, exchange) => {
    assert.equal(cmd, 'codex');
    assert.deepEqual(args, ['app-server']);
    const inbox = [];
    const send = (msg) => {
      sent.push(msg);
      if (msg.id === 1 && msg.method === 'initialize') {
        inbox.push({ id: 1, result: { serverInfo: { name: 'fake-codex' } } });
      } else if (msg.id === 2 && msg.method === 'account/rateLimits/read') {
        inbox.push({
          id: 2,
          result: {
            accountId: 'acct_secret_123',
            email: 'synthetic@users.noreply.github.com',
            rateLimitsByLimitId: {
              codex_default: {
                primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.floor((NOW + 7_200_000) / 1000) },
                secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: Math.floor((NOW + 86_400_000) / 1000) },
              },
              codex_free: {
                primary: { usedPercent: 10, windowDurationMins: 43200, resetsAt: Math.floor((NOW + 172_800_000) / 1000) },
                secondary: null,
              },
              codex_astra_tier: {
                primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: Math.floor((NOW + 86_400_000) / 1000) },
                secondary: null,
              },
            },
          },
        });
      }
      return true;
    };
    const receive = async (pred) => {
      const idx = inbox.findIndex(pred);
      return idx >= 0 ? inbox.splice(idx, 1)[0] : null;
    };
    const result = await exchange({ send, receive });
    return { ok: Boolean(result), error: null, result };
  };

  const res = await readProviderQuota('codex', { rpcRunner: fakeRpc, now: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(sent.length, 3);
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[1].method, 'initialized');
  assert.equal(sent[2].method, 'account/rateLimits/read');
  assert.equal(res.windows.length, 4);
  assert.deepEqual(res.windows.map((w) => [w.pool, w.windowMinutes, w.remainingPct]), [
    ['standard', 300, 75],
    ['standard', 10080, 40],
    ['standard', 43200, 90],
    ['astra', 10080, 20],
  ]);
  for (const w of res.windows) {
    assert.deepEqual(Object.keys(w).sort(), ['pool', 'provider', 'remainingPct', 'resetsAt', 'windowMinutes']);
  }
  assert.equal(JSON.stringify(res).includes('acct_secret_123'), false);
  assert.doesNotMatch(JSON.stringify(res), /noreply/);

  // Timeout / RPC failure returns unknown.
  const timedOut = await readProviderQuota('codex', {
    rpcRunner: async () => ({ ok: false, error: { code: 'ETIMEDOUT' }, result: null }),
    now: NOW,
  });
  assert.deepEqual(timedOut, { status: 'unknown', windows: [] });

  // Direct parser check on malformed input.
  assert.deepEqual(parseCodexRateLimits(null), []);
});

test('rpcRunner talks newline JSON-RPC to a child process and kills on timeout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-rpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const serverScript = path.join(dir, 'fake-server.mjs');
  fs.writeFileSync(serverScript, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
      if (msg.method === 'account/rateLimits/read') {
        process.stdout.write(JSON.stringify({
          id: msg.id,
          result: { rateLimitsByLimitId: { default: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null } } },
        }) + '\\n');
      }
    });
  `);
  const rpc = rpcRunner();
  const ok = await rpc(process.execPath, [serverScript], async ({ send, receive }) => {
    send({ id: 1, method: 'initialize' });
    const r1 = await receive((m) => m.id === 1);
    assert.equal(r1?.result?.ok, true);
    send({ method: 'initialized' });
    send({ id: 2, method: 'account/rateLimits/read' });
    return (await receive((m) => m.id === 2))?.result ?? null;
  }, { timeout: 5000 });
  assert.equal(ok.ok, true);
  assert.equal(parseCodexRateLimits(ok.result)[0].remainingPct, 95);

  const hangScript = path.join(dir, 'hang.mjs');
  fs.writeFileSync(hangScript, 'setInterval(() => {}, 10000);');
  const timed = await rpc(process.execPath, [hangScript], async ({ receive }) => receive(() => true), { timeout: 150 });
  assert.equal(timed.ok, false);
  assert.equal(timed.error?.code, 'ETIMEDOUT');
});

test('antigravity TSV reader parses pools, windows, and 1970 not-started resets', async () => {
  const tsv = [
    'Gemini Models\tWeekly Limit Remaining\t22%\t2026-12-03T19:28:12Z',
    'Gemini Models\tFive Hour Limit Remaining\t80%\t2026-11-26T17:00:00Z',
    'Claude and GPT models\tWeekly Limit Remaining\t0%\t1970-01-01T00:00:00Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t45%\t2026-11-26T15:00:00Z',
  ].join('\n');
  const calls = [];
  const res = await readProviderQuota('antigravity', {
    which: (name) => (name === 'antigravity' ? '/fake/antigravity' : null),
    runner: async (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: tsv, stderr: '' };
    },
    now: NOW,
  });
  assert.deepEqual(calls, [['/fake/antigravity', ['-p', '/usage']]]);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.windows, [
    { provider: 'antigravity', pool: 'standard', windowMinutes: 10080, remainingPct: 22, resetsAt: '2026-12-03T19:28:12.000Z' },
    { provider: 'antigravity', pool: 'standard', windowMinutes: 300, remainingPct: 80, resetsAt: '2026-11-26T17:00:00.000Z' },
    { provider: 'antigravity', pool: 'third-party-claude', windowMinutes: 10080, remainingPct: 100, resetsAt: null },
    { provider: 'antigravity', pool: 'third-party-claude', windowMinutes: 300, remainingPct: 45, resetsAt: '2026-11-26T15:00:00.000Z' },
  ]);
  assert.deepEqual(parseAntigravityUsage('garbage'), []);
});

test('claude reader is off by default and parses ANSI + IANA timezone output when opted in', async () => {
  let called = 0;
  const runner = async (cmd, args) => {
    called += 1;
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, ['-p', '/usage']);
    return {
      status: 0,
      stdout: '\x1b[1mCurrent session: 6% used · resets Nov 28, 7:30am (Europe/Bucharest)\x1b[0m\n'
        + 'Current week (all models): 86% used · resets Dec 1, 11am (Europe/Bucharest)\n'
        + 'Current week (Fable): 98% used · resets Dec 1, 11am (Europe/Bucharest)\n',
      stderr: '',
    };
  };

  // Off by default: never invokes runner.
  const off = await readProviderQuota('claude', { runner, now: NOW });
  assert.deepEqual(off, { status: 'unknown', windows: [] });
  assert.equal(called, 0);

  // Opt-in: parses ANSI and IANA timezone (Europe/Bucharest is UTC+2 in Nov/Dec).
  const on = await readProviderQuota('claude', { runner, claudeUsage: true, now: NOW });
  assert.equal(called, 1);
  assert.equal(on.status, 'ok');
  assert.deepEqual(on.windows, [
    { provider: 'claude', pool: 'standard', windowMinutes: 300, remainingPct: 94, resetsAt: '2026-11-28T05:30:00.000Z' },
    { provider: 'claude', pool: 'standard', windowMinutes: 10080, remainingPct: 14, resetsAt: '2026-12-01T09:00:00.000Z' },
    { provider: 'claude', pool: 'fable', windowMinutes: 10080, remainingPct: 2, resetsAt: '2026-12-01T09:00:00.000Z' },
  ]);

  // Invalid timezone -> skipped/unknown.
  assert.deepEqual(parseClaudeUsage('Current session: 10% used · resets Nov 28, 7:30am (Mars/Olympus)', NOW), []);
});

test('refreshQuota caches with TTL, strips PII, and writes <=3% threshold auto-locks without shortening', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);

  // Pre-existing longer lock on provider:codex must not be shortened.
  const longerUntil = after(5 * 86_400_000);
  quotaSet(box.target, 'codex', { until: longerUntil, now: NOW, log: () => {} });

  let rpcCalls = 0;
  const fakeRpc = async (cmd, args, exchange) => {
    rpcCalls += 1;
    const inbox = [];
    const send = (msg) => {
      if (msg.id === 1) inbox.push({ id: 1, result: {} });
      if (msg.id === 2) {
        inbox.push({
          id: 2,
          result: {
            accountId: 'acct_private',
            rateLimitsByLimitId: {
              main: {
                primary: { usedPercent: 98, windowDurationMins: 300, resetsAt: Math.floor((NOW + 3_600_000) / 1000) },
                secondary: null,
              },
            },
          },
        });
      }
      return true;
    };
    const receive = async (pred) => {
      const idx = inbox.findIndex(pred);
      return idx >= 0 ? inbox.splice(idx, 1)[0] : null;
    };
    return { ok: true, error: null, result: await exchange({ send, receive }) };
  };

  let agyCalls = 0;
  const fakeRunner = async () => {
    agyCalls += 1;
    return {
      status: 0,
      stdout: `Gemini Models\tFive Hour Limit Remaining\t2%\t${after(7_200_000)}\n`
        + `Claude and GPT models\tWeekly Limit Remaining\t50%\t${after(86_400_000)}\n`,
      stderr: '',
    };
  };

  const first = await refreshQuota(box.target, {
    providers: ['codex', 'antigravity'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW,
  });
  assert.equal(rpcCalls, 1);
  assert.equal(agyCalls, 1);
  assert.equal(first.stale, false);

  // Cache file exists, has no PII, and is fresh within TTL.
  const cacheFile = box.path(QUOTA_FILE);
  assert.ok(fs.existsSync(cacheFile));
  assert.equal(fs.readFileSync(cacheFile, 'utf8').includes('acct_private'), false);
  assert.equal(readQuotaCache(box.target, NOW + 60_000).stale, false);
  assert.equal(readQuotaCache(box.target, NOW + 300_001).stale, true);

  // Second call within TTL uses cache without invoking runners.
  const cached = await refreshQuota(box.target, {
    providers: ['codex', 'antigravity'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW + 60_000,
  });
  assert.equal(rpcCalls, 1);
  assert.equal(agyCalls, 1);
  assert.equal(cached.windows.length, 3);

  // Auto-locks: antigravity standard locked until resetsAt; codex longer lock was NOT shortened.
  const cooldowns = readCooldowns(box.path(COOLDOWN_FILE));
  assert.equal(cooldowns['tier:antigravity:standard'].until, after(7_200_000));
  assert.equal(cooldowns['tier:antigravity:standard'].source, 'quota');
  assert.equal(cooldowns['tier:antigravity:third-party-claude'], undefined);
  assert.equal(cooldowns['provider:codex'].until, longerUntil);
});

test('quotaCheck --on-error supports <2m wait-retry and burst failover locks', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus', '--antigravity-tier', 'pro').status, 0);

  // 1) Short reset (<120s): waits, prunes expired lock, returns action 'retry'.
  const waited = [];
  const shortRes = await quotaCheck(box.target, {
    subject: 'antigravity',
    onError: true,
    now: NOW,
    sleep: async (ms) => { waited.push(ms); },
    log: () => {},
    runner: async () => ({
      status: 0,
      stdout: `Gemini Models\tFive Hour Limit Remaining\t1%\t${after(45_000)}\n`,
      stderr: '',
    }),
  });
  assert.equal(shortRes.action, 'retry');
  assert.equal(shortRes.waitedMs, 45_000);
  assert.deepEqual(waited, [45_000]);
  assert.equal(readCooldowns(box.path(COOLDOWN_FILE))['tier:antigravity:standard'], undefined);

  // 2) No window <= minRemainingPct: writes burst lock on tier:<provider>:<pool> and returns 'failover'.
  const burstRes = await quotaCheck(box.target, {
    subject: 'antigravity:claude-opus-5-5',
    onError: true,
    now: NOW,
    log: () => {},
    runner: async () => ({
      status: 0,
      stdout: `Claude and GPT models\tFive Hour Limit Remaining\t65%\t${after(3_600_000)}\n`,
      stderr: '',
    }),
  });
  assert.equal(burstRes.action, 'failover');
  assert.equal(burstRes.waitedMs, 0);
  const burstLock = readCooldowns(box.path(COOLDOWN_FILE))['tier:antigravity:third-party-claude'];
  assert.equal(burstLock.window, 'burst');
  assert.equal(burstLock.until, after(300_000));
});

test('paceScore, applicableWindows, lockKeyForWindow, and loadConfig quota validation', (t) => {
  const windows = [
    { provider: 'antigravity', pool: 'standard', windowMinutes: 300, remainingPct: 50, resetsAt: after(150 * 60_000) },
    { provider: 'antigravity', pool: 'third-party-claude', windowMinutes: 10080, remainingPct: 100, resetsAt: null },
    { provider: 'codex', pool: 'standard', windowMinutes: 300, remainingPct: 20, resetsAt: after(150 * 60_000) },
    { provider: 'codex', pool: 'astra', windowMinutes: 10080, remainingPct: 80, resetsAt: after(5040 * 60_000) },
  ];
  assert.equal(applicableWindows(windows, 'antigravity', 'standard').length, 1);
  assert.equal(applicableWindows(windows, 'codex', 'astra').length, 2);
  assert.equal(paceScore(windows, 'antigravity', 'standard', NOW), 100);
  assert.equal(paceScore(windows, 'antigravity', 'third-party-claude', NOW), 100);
  assert.equal(paceScore(windows, 'codex', 'astra', NOW), 40);
  assert.equal(paceScore(windows, 'claude', 'standard', NOW), null);

  assert.deepEqual(lockKeyForWindow('antigravity', 'standard'), { key: 'tier:antigravity:standard', scope: 'tier', tier: 'standard' });
  assert.deepEqual(lockKeyForWindow('antigravity', 'third-party-claude'), { key: 'tier:antigravity:third-party-claude', scope: 'tier', tier: 'third-party-claude' });
  assert.deepEqual(lockKeyForWindow('codex', 'standard'), { key: 'provider:codex', scope: 'provider' });
  assert.deepEqual(lockKeyForWindow('codex', 'astra'), { key: 'tier:codex:astra', scope: 'tier', tier: 'astra' });
  assert.deepEqual(lockKeyForWindow('claude', 'fable'), { key: 'tier:claude:fable', scope: 'tier', tier: 'fable' });

  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus', '--antigravity-tier', 'pro').status, 0);
  const cfgPath = box.path('auto-build.config.json');
  const raw = json(cfgPath);
  write(cfgPath, { ...raw, quota: { minRemainingPct: 5, ttlMs: 120_000, claudeUsage: true, burstLockMs: 60_000 } });
  assert.deepEqual(loadConfig(box.target).quota, { minRemainingPct: 5, ttlMs: 120_000, claudeUsage: true, burstLockMs: 60_000 });
});

test('leftover (b): quotaClear --all invalidates timed-out lock so holder aborts, retries empty lock dir, and stillHeld aborts reclaimed writer', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const cdFile = box.path(COOLDOWN_FILE);
  const cdLock = `${cdFile}.lock`;

  // Live regular .lock file -> lock invalidated with warning, cooldown cleared, simulated holder's write aborts.
  write(cdFile, { 'provider:codex': { scope: 'provider', window: '5h', until: after(60_000), reason: 'live', source: 'manual' } });
  const heldLogs = [];
  assert.throws(() => {
    updateCooldowns(cdFile, (current, stillHeld) => {
      assert.equal(stillHeld(), true);
      quotaClear(box.target, { all: true }, { log: (line) => heldLogs.push(line), timeoutMs: 25 });
      assert.equal(stillHeld(), false);
      return { data: { ...current, 'provider:claude': { scope: 'provider', window: '5h', until: after(60_000), reason: 'stale-write', source: 'manual' } } };
    }, { now: NOW });
  }, { code: 'ELOCKED' });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.match(heldLogs.join('\n'), /warning:.*timed out waiting for lock/);

  // Empty .lock directory -> cleared, retried under lock, cooldown file removed.
  fs.mkdirSync(cdLock);
  const logs = [];
  quotaClear(box.target, { all: true }, { log: (line) => logs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.ok(logs.some((line) => line.includes('warning:')));

  // Non-empty .lock directory -> clears cooldown file with warning, leaves dir and contents intact.
  write(cdFile, '{ corrupt');
  const keepInLock = path.join(cdLock, 'keep.txt');
  write(keepInLock, 'KEEP');
  const nonEmptyLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => nonEmptyLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.readFileSync(keepInLock, 'utf8'), 'KEEP');
  assert.ok(nonEmptyLogs.some((line) => line.includes('warning:')));
  fs.rmSync(cdLock, { recursive: true, force: true });

  // Non-empty .lock.guard directory -> clears cooldown file with warning, leaves guard contents intact and no .lock.
  const cdGuard = `${cdLock}.guard`;
  write(cdFile, '{ corrupt');
  const keepInGuard = path.join(cdGuard, 'keep.txt');
  write(keepInGuard, 'KEEP-GUARD');
  const guardLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => guardLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.equal(fs.readFileSync(keepInGuard, 'utf8'), 'KEEP-GUARD');
  assert.ok(guardLogs.some((line) => line.includes('warning:')));
  fs.rmSync(cdGuard, { recursive: true, force: true });

  // Symlink/junction at .lock.guard -> clears cooldown file with warning without following or deleting target.
  const outsideDir = path.join(box.dir, 'outside-target');
  const outsideFile = path.join(outsideDir, 'precious.txt');
  write(outsideFile, 'SAFE');
  fs.symlinkSync(outsideDir, cdGuard, process.platform === 'win32' ? 'junction' : 'dir');
  write(cdFile, '{ corrupt');
  const linkLogs = [];
  quotaClear(box.target, { all: true }, { log: (line) => linkLogs.push(line) });
  assert.equal(fs.existsSync(cdFile), false);
  assert.equal(fs.existsSync(cdLock), false);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'SAFE');
  assert.ok(fs.lstatSync(cdGuard).isSymbolicLink());
  assert.ok(linkLogs.some((line) => line.includes('warning:')));
  fs.rmSync(cdGuard, { force: true });

  // Reclaimed stale lock holder aborts its write via stillHeld().
  write(cdFile, { 'provider:claude': { scope: 'provider', window: '5h', until: after(60_000), reason: 'initial', source: 'manual' } });
  assert.throws(() => {
    updateCooldowns(cdFile, (current, stillHeld) => {
      assert.equal(stillHeld(), true);
      // Simulate another process reclaiming the lock with a new token.
      fs.writeFileSync(cdLock, '88888:reclaimer\n');
      assert.equal(stillHeld(), false);
      return { data: { ...current, 'provider:codex': { scope: 'provider', window: '5h', until: after(60_000), reason: 'stale-write', source: 'manual' } } };
    }, { now: NOW });
  }, { code: 'ELOCKED' });
  assert.equal(readCooldowns(cdFile)['provider:codex'], undefined);
  assert.ok(readCooldowns(cdFile)['provider:claude']);
  fs.rmSync(cdLock, { force: true });

  // Direct withFileLock stillHeld check.
  withFileLock(cdFile, (stillHeld) => {
    assert.equal(stillHeld(), true);
  });
});

test('B1: applyQuotaLocks caps far-future resetsAt by windowMinutes and MAX_LOCK, and returns {} on write failure', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const agy = parseAntigravityUsage('Gemini Models\tFive Hour Limit Remaining\t0%\t2099-01-01T00:00:00Z\n');
  const monthly = { provider: 'codex', pool: 'standard', windowMinutes: 43_200, remainingPct: 0, resetsAt: '2099-01-01T00:00:00.000Z' };
  const locks = applyQuotaLocks(box.target, [...agy, monthly], { now: NOW });
  assert.equal(locks['tier:antigravity:standard'].until, after(300 * 60_000));
  assert.equal(locks['provider:codex'].until, after(MAX_LOCK));
  const stored = readCooldowns(box.path(COOLDOWN_FILE));
  assert.equal(stored['tier:antigravity:standard'].until, after(300 * 60_000));
  assert.equal(stored['provider:codex'].until, after(MAX_LOCK));

  // Failed cooldown write must not report locks as written.
  const cdLock = `${box.path(COOLDOWN_FILE)}.lock`;
  fs.mkdirSync(cdLock);
  const failed = applyQuotaLocks(box.target, [
    { provider: 'claude', pool: 'standard', windowMinutes: 300, remainingPct: 0, resetsAt: after(60_000) },
  ], { now: NOW });
  assert.deepEqual(failed, {});
  fs.rmdirSync(cdLock);
});

test('B3: refreshQuota tracks per-provider checkedAt and never re-stamps or returns stale cached providers', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  let codexCalls = 0;
  let agyCalls = 0;
  const fakeRpc = async (cmd, args, exchange) => {
    codexCalls += 1;
    const inbox = [];
    const send = (msg) => {
      if (msg.id === 1) inbox.push({ id: 1, result: {} });
      if (msg.id === 2) {
        inbox.push({
          id: 2,
          result: {
            rateLimitsByLimitId: {
              main: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor((NOW + 7_200_000) / 1000) } },
            },
          },
        });
      }
      return true;
    };
    const receive = async (pred) => {
      const idx = inbox.findIndex(pred);
      return idx >= 0 ? inbox.splice(idx, 1)[0] : null;
    };
    return { ok: true, error: null, result: await exchange({ send, receive }) };
  };
  const fakeRunner = async () => {
    agyCalls += 1;
    return {
      status: 0,
      stdout: `Gemini Models\tFive Hour Limit Remaining\t50%\t${after(7_200_000)}\n`,
      stderr: '',
    };
  };

  // T0: populate both providers.
  await refreshQuota(box.target, { providers: ['codex', 'antigravity'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW });
  assert.equal(codexCalls, 1);
  assert.equal(agyCalls, 1);

  // T0 + 200s: refresh only codex -> antigravity keeps T0 checkedAt (not re-stamped to T0 + 200s).
  await refreshQuota(box.target, { providers: ['codex'], refresh: true, rpcRunner: fakeRpc, runner: fakeRunner, now: NOW + 200_000 });
  assert.equal(codexCalls, 2);
  assert.equal(agyCalls, 1);
  const midCache = readQuotaCache(box.target, NOW + 350_000);
  assert.equal(midCache.data.providers.codex.checkedAt, after(200_000));
  assert.equal(midCache.data.providers.antigravity.checkedAt, after(0));
  assert.equal(midCache.stale, true);
  assert.equal(midCache.staleByProvider.codex, false);
  assert.equal(midCache.staleByProvider.antigravity, true);
  assert.equal(isProviderFresh(midCache.data.providers.codex, NOW + 350_000), true);
  assert.equal(isProviderFresh(midCache.data.providers.antigravity, NOW + 350_000), false);

  // T0 + 400s: codex is still fresh (200s old) while antigravity is stale (400s old) -> cache hit for codex, excludes stale antigravity.
  const cachedCodex = await refreshQuota(box.target, { providers: ['codex'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW + 400_000 });
  assert.equal(codexCalls, 2);
  assert.deepEqual(cachedCodex.windows.map((w) => w.provider), ['codex']);

  // T0 + 550s: both stale; refresh only codex -> stale antigravity is NOT re-stamped or returned.
  const onlyCodex = await refreshQuota(box.target, { providers: ['codex'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW + 550_000 });
  assert.equal(codexCalls, 3);
  assert.deepEqual(onlyCodex.windows.map((w) => w.provider), ['codex']);

  // T0 + 551s: requesting both skips fresh codex and fetches stale/missing antigravity.
  const both = await refreshQuota(box.target, { providers: ['codex', 'antigravity'], rpcRunner: fakeRpc, runner: fakeRunner, now: NOW + 551_000 });
  assert.equal(codexCalls, 3);
  assert.equal(agyCalls, 2);
  assert.equal(both.windows.length, 2);
});

test('B4 & NITs: quotaCheck --on-error burst-locks when resetsAt is null/past, strips @effort, and parsers reject malformed fields', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus', '--antigravity-tier', 'pro').status, 0);

  // Exhausted window with past resetsAt is NOT exhausted for auto-lock -> burst-lock path must run.
  const pastRes = await quotaCheck(box.target, {
    subject: 'antigravity:claude-opus-5-5@medium',
    onError: true,
    now: NOW,
    log: () => {},
    runner: async () => ({
      status: 0,
      stdout: `Claude and GPT models\tFive Hour Limit Remaining\t0%\t${after(-60_000)}\n`,
      stderr: '',
    }),
  });
  assert.equal(pastRes.action, 'failover');
  const burstLock = readCooldowns(box.path(COOLDOWN_FILE))['tier:antigravity:third-party-claude'];
  assert.ok(burstLock);
  assert.equal(burstLock.window, 'burst');

  // Exhausted window with resetsAt null (Codex without resetsAt) also takes burst-lock path.
  quotaClear(box.target, { all: true }, { log: () => {} });
  const nullResetRes = await quotaCheck(box.target, {
    subject: 'codex:gpt-6.2-sol@high',
    onError: true,
    now: NOW,
    log: () => {},
    rpcRunner: async (cmd, args, exchange) => {
      const inbox = [];
      const send = (msg) => {
        if (msg.id === 1) inbox.push({ id: 1, result: {} });
        if (msg.id === 2) {
          inbox.push({
            id: 2,
            result: { rateLimitsByLimitId: { main: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } } } },
          });
        }
        return true;
      };
      const receive = async (pred) => {
        const idx = inbox.findIndex(pred);
        return idx >= 0 ? inbox.splice(idx, 1)[0] : null;
      };
      return { ok: true, error: null, result: await exchange({ send, receive }) };
    },
  });
  assert.equal(nullResetRes.action, 'failover');
  assert.equal(readCooldowns(box.path(COOLDOWN_FILE))['tier:codex:standard']?.window, 'burst');

  // NIT: parseClaudeReset accepts "resets Dec 1 at 11am" and parseClaudeUsage returns [] if any expected line fails.
  const claudeAt = parseClaudeUsage('Current week (all models): 50% used · resets Dec 1 at 11am (Europe/Bucharest)\n', NOW);
  assert.equal(claudeAt.length, 1);
  assert.equal(claudeAt[0].resetsAt, '2026-12-01T09:00:00.000Z');
  const claudePartialFail = parseClaudeUsage(
    'Current session: 6% used · resets Nov 28, 7:30am (Europe/Bucharest)\n'
    + 'Current week (all models): 86% used · resets garbage (Europe/Bucharest)\n',
    NOW,
  );
  assert.deepEqual(claudePartialFail, []);

  // NIT: null usedPercent is not coerced to 0; fractional windowMinutes rounding to 0 is skipped.
  assert.deepEqual(parseCodexRateLimits({
    rateLimitsByLimitId: {
      main: {
        primary: { usedPercent: null, windowDurationMins: 300, resetsAt: Math.floor((NOW + 60_000) / 1000) },
        secondary: { usedPercent: 10, windowDurationMins: 0.2, resetsAt: Math.floor((NOW + 60_000) / 1000) },
      },
    },
  }), []);
  assert.equal(sanitizeWindow({ provider: 'codex', pool: 'standard', windowMinutes: 0.4, remainingPct: 50, resetsAt: null }), null);
});

test('B5: config.quota rejects ttlMs 0 and is preserved across v1/v2 loadConfig and upgrade', (t) => {
  const boxV1 = sandbox(t);
  assert.equal(boxV1.cli('init', '--yes').status, 0);
  const v1Path = boxV1.path(CONFIG_FILE);
  const v1Raw = json(v1Path);
  assert.equal(v1Raw.schemaVersion, undefined);
  const quotaCfg = { minRemainingPct: 5, ttlMs: 120_000, claudeUsage: true, burstLockMs: 60_000 };

  // ttlMs: 0 is rejected by configProblem and loadConfig.
  assert.match(configProblem(completeConfig({ ...v1Raw, quota: { ttlMs: 0 } })), /^"quota"/);
  write(v1Path, { ...v1Raw, quota: { ttlMs: 0 } });
  assert.equal(loadConfig(boxV1.target).quota, undefined);

  // Valid quota is preserved by loadConfig on v1 and survives upgrade to v3.
  write(v1Path, { ...v1Raw, quota: quotaCfg });
  assert.deepEqual(loadConfig(boxV1.target).quota, quotaCfg);
  const upgradedV1 = upgrade(boxV1.target, { log: () => {} });
  assert.equal(upgradedV1.upgraded, true);
  assert.deepEqual(upgradedV1.config.quota, quotaCfg);
  assert.deepEqual(loadConfig(boxV1.target).quota, quotaCfg);

  // Valid quota is preserved by loadConfig on v2 and survives upgrade to v3.
  const boxV2 = sandbox(t);
  assert.equal(boxV2.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus').status, 0);
  const v2Path = boxV2.path(CONFIG_FILE);
  const v2Raw = { ...json(v2Path), schemaVersion: 2, quota: quotaCfg };
  delete v2Raw.telemetry;
  delete v2Raw.preflight;
  write(v2Path, v2Raw);
  assert.deepEqual(loadConfig(boxV2.target).quota, quotaCfg);
  const upgradedV2 = upgrade(boxV2.target, { log: () => {} });
  assert.equal(upgradedV2.upgraded, true);
  assert.deepEqual(upgradedV2.config.quota, quotaCfg);
});

test('NIT 1: cache provider entry with missing or invalid checkedAt is stale even when top-level checkedAt is fresh', (t) => {
  const box = sandbox(t);
  write(box.path(QUOTA_FILE), {
    schemaVersion: 1,
    checkedAt: after(0),
    ttlMs: 300_000,
    providers: {
      codex: {
        status: 'ok',
        windows: [{ provider: 'codex', pool: 'standard', windowMinutes: 300, remainingPct: 80, resetsAt: after(3_600_000) }],
      },
      antigravity: {
        status: 'ok',
        checkedAt: 'not-a-date',
        windows: [{ provider: 'antigravity', pool: 'standard', windowMinutes: 300, remainingPct: 80, resetsAt: after(3_600_000) }],
      },
    },
  });
  const cached = readQuotaCache(box.target, NOW + 1_000);
  assert.equal(cached.data.providers.codex.checkedAt, null);
  assert.equal(cached.data.providers.antigravity.checkedAt, null);
  assert.equal(cached.staleByProvider.codex, true);
  assert.equal(cached.staleByProvider.antigravity, true);
  assert.equal(cached.stale, true);
});

test('NIT 2: refreshQuota returns only requested providers windows on cache-hit and refresh paths', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  write(box.path(QUOTA_FILE), {
    schemaVersion: 1,
    checkedAt: after(0),
    ttlMs: 300_000,
    providers: {
      codex: {
        status: 'ok',
        checkedAt: after(0),
        windows: [{ provider: 'codex', pool: 'standard', windowMinutes: 300, remainingPct: 80, resetsAt: after(3_600_000) }],
      },
      antigravity: {
        status: 'ok',
        checkedAt: after(0),
        windows: [{ provider: 'antigravity', pool: 'standard', windowMinutes: 300, remainingPct: 60, resetsAt: after(3_600_000) }],
      },
    },
  });

  // Cache-hit path: requesting only codex excludes fresh antigravity windows.
  const hit = await refreshQuota(box.target, { providers: ['codex'], now: NOW + 10_000 });
  assert.deepEqual(hit.windows.map((w) => w.provider), ['codex']);

  // Refresh path: refreshing only codex still excludes fresh cached antigravity windows.
  const refreshed = await refreshQuota(box.target, {
    providers: ['codex'],
    refresh: true,
    now: NOW + 20_000,
    rpcRunner: async (cmd, args, exchange) => {
      const inbox = [];
      const send = (msg) => {
        if (msg.id === 1) inbox.push({ id: 1, result: {} });
        if (msg.id === 2) {
          inbox.push({
            id: 2,
            result: { rateLimitsByLimitId: { main: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor((NOW + 3_600_000) / 1000) } } } },
          });
        }
        return true;
      };
      const receive = async (pred) => {
        const idx = inbox.findIndex(pred);
        return idx >= 0 ? inbox.splice(idx, 1)[0] : null;
      };
      return { ok: true, error: null, result: await exchange({ send, receive }) };
    },
  });
  assert.deepEqual(refreshed.windows.map((w) => w.provider), ['codex']);
});

test('NIT 3: refreshQuota skips cache and lock writes when AbortSignal aborts before completion', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const ac = new AbortController();
  let releaseReader;
  const readerDone = new Promise((resolve) => { releaseReader = resolve; });

  const pending = refreshQuota(box.target, {
    providers: ['antigravity'],
    now: NOW,
    signal: ac.signal,
    runner: async () => {
      await readerDone;
      return { status: 0, stdout: `Gemini Models\tFive Hour Limit Remaining\t0%\t${after(3_600_000)}\n`, stderr: '' };
    },
  });
  ac.abort();
  const res = await pending;
  releaseReader();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(res.stale, true);
  assert.deepEqual(res.locks, {});
  assert.equal(fs.existsSync(box.path(QUOTA_FILE)), false);
  assert.equal(fs.existsSync(box.path(COOLDOWN_FILE)), false);
});

test('NIT 4: quotaCheck with burstLockMs 0 skips writing expired burst lock and logs why', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus', '--antigravity-tier', 'pro').status, 0);
  const cfgPath = box.path(CONFIG_FILE);
  write(cfgPath, { ...json(cfgPath), quota: { burstLockMs: 0 } });

  const logs = [];
  const res = await quotaCheck(box.target, {
    subject: 'antigravity:claude-opus-5-5',
    onError: true,
    now: NOW,
    log: (line) => logs.push(line),
    runner: async () => ({
      status: 0,
      stdout: `Claude and GPT models\tFive Hour Limit Remaining\t65%\t${after(3_600_000)}\n`,
      stderr: '',
    }),
  });
  assert.equal(res.action, 'failover');
  assert.deepEqual(res.locks, {});
  assert.equal(fs.existsSync(box.path(COOLDOWN_FILE)), false);
  assert.match(logs.join('\n'), /burstLockMs=0/);
  assert.doesNotMatch(logs.join('\n'), /burst locked/);
});

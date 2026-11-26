import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isLocked, parseRateLimit, prune, readCooldowns, summarize, writeCooldowns } from '../hooks/_quota.mjs';
import { quotaCheck, quotaClear, quotaSet, quotaStatus } from '../lib/quota.mjs';
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
  assert.equal(hit('model:claude-sonnet-5-5', { model: 'claude-sonnet-5-5' }), 'model:claude-sonnet-5-5');
  assert.equal(hit('model:claude-sonnet-5-5', { providers: ['antigravity'], model: 'claude-sonnet-5-5' }), 'model:claude-sonnet-5-5');

  const legacy = lock('tier:claude:heavy');
  assert.equal(isLocked(legacy, { model: 'claude-opus-5-5', config }, NOW)?.key, 'tier:claude:heavy');
  assert.equal(isLocked(legacy, { model: 'claude-fable-5-2', config }, NOW)?.key, 'tier:claude:heavy');
  assert.equal(isLocked(lock('tier:codex:heavy'), { model: 'gpt-6-astra', config }, NOW)?.key, 'tier:codex:heavy');
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

test('quota check injects commands, ignores hedged exhaustion, and records explicit exhaustion', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const calls = [];
  const logs = [];
  const result = await quotaCheck(box.target, {
    providers: ['claude', 'codex'], now: NOW, log: (line) => logs.push(line),
    runner: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return cmd === 'claude'
        ? { status: 0, stdout: 'no limit reached', stderr: '' }
        : { status: 1, stdout: 'limit reached\nresets Monday', stderr: '' };
    },
  });
  assert.deepEqual(calls.map((call) => [call.cmd, call.args]), [['claude', ['auth', 'status']], ['codex', ['login', 'status']]]);
  assert.deepEqual(Object.keys(result), ['provider:codex']);
  assert.equal(result['provider:codex'].window, 'weekly');
  assert.ok(logs.some((line) => line.includes('using recorded cooldowns')));
  const { setAt, recheckAfter, ...stored } = json(box.path('auto-build-cooldowns.json'))['provider:codex'];
  assert.deepEqual(stored, result['provider:codex']);
  assert.equal(Date.parse(recheckAfter) - Date.parse(setAt), 6 * 3_600_000);
});

test('quota check falls back gracefully for missing CLIs and unsupported providers', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  quotaSet(box.target, 'claude', { window: 'burst', now: NOW, log: () => {} });
  const logs = [];
  const result = await quotaCheck(box.target, {
    providers: ['claude', 'antigravity'], now: NOW, log: (line) => logs.push(line),
    runner: async (cmd) => cmd === 'claude' ? { error: { code: 'ENOENT' }, status: null } : { status: 0, stdout: '', stderr: '' },
  });
  assert.deepEqual(result, {});
  assert.ok(logs.some((line) => line.includes('cli not found')));
  assert.ok(logs.some((line) => line.includes('no official status command')));
  assert.ok(fs.existsSync(box.path('auto-build-cooldowns.json')));
});

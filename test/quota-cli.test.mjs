import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCooldowns, SCARCE_POOL } from '../hooks/_quota.mjs';
import { quotaClear, quotaSet } from '../lib/quota.mjs';
import { json, sandbox, write } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 26, 12);

test('quota set writes provider, bare model, qualified model, pool, and legacy scarce keys', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const opts = { now: NOW, log: () => {} };

  assert.equal(quotaSet(box.target, 'claude', opts).key, 'provider:claude');
  assert.equal(quotaSet(box.target, 'claude-sonnet-5-5', opts).key, 'model:claude-sonnet-5-5');
  assert.equal(quotaSet(box.target, 'antigravity:claude-opus-5-5', opts).key, 'model:antigravity:claude-opus-5-5');
  assert.equal(quotaSet(box.target, 'claude', { ...opts, pool: 'fable' }).key, 'tier:claude:fable');
  assert.equal(quotaSet(box.target, 'claude', { ...opts, heavy: true }).key, 'tier:claude:fable');
  assert.equal(quotaSet(box.target, 'codex:gpt-6.1-sol', { ...opts, pool: 'custom-pool' }).key, 'tier:codex:custom-pool');

  assert.throws(() => quotaSet(box.target, 'work:gpt-6-luna', opts), /unknown provider/);
  assert.throws(() => quotaSet(box.target, 'claude', { ...opts, pool: 'bad_pool' }), /invalid pool/);
  const records = readCooldowns(box.path('auto-build-cooldowns.json'));
  assert.equal(records['tier:claude:fable'].tier, 'fable');
  assert.equal(records['tier:codex:custom-pool'].scope, 'tier');
});

test('quota clear recognizes provider-qualified model keys and all provider pool keys', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const opts = { now: NOW, log: () => {} };
  quotaSet(box.target, 'antigravity:claude-opus-5-5', opts);
  assert.deepEqual(quotaClear(box.target, 'antigravity:claude-opus-5-5', opts), ['model:antigravity:claude-opus-5-5']);
  quotaSet(box.target, 'claude', { ...opts, pool: 'fable' });
  quotaSet(box.target, 'claude', { ...opts, pool: 'special' });
  assert.deepEqual(quotaClear(box.target, 'claude', opts).sort(), ['tier:claude:fable', 'tier:claude:special']);
});

test('quota set uses host for tier lookup with custom modelIds and falls back to heavy pool when SCARCE_POOL entry is absent', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const configPath = box.path('auto-build.config.json');
  const config = json(configPath);
  config.modelIds = { 'Claude Opus 5.5': 'opus-custom' };
  config.tiers = { claude: { plan: 'max', sharing: 'heavy-tier-only', resetDay: 'friday' } };
  write(configPath, config);
  const opts = { now: NOW, log: () => {} };

  const weekly = quotaSet(box.target, 'Claude Opus 5.5', { ...opts, window: 'weekly' });
  assert.equal(weekly.key, 'model:opus-custom');
  assert.equal(weekly.entry.until, '2026-11-27T00:00:00.000Z');

  const savedPool = SCARCE_POOL.claude;
  delete SCARCE_POOL.claude;
  try {
    const heavy = quotaSet(box.target, 'claude', { ...opts, heavy: true });
    assert.equal(heavy.key, 'tier:claude:heavy');
    assert.equal(heavy.entry.tier, 'heavy');
  } finally {
    SCARCE_POOL.claude = savedPool;
  }
});

test('quota clear removes malformed bare keys for qualified models, cased/display qualified keys, and tier provider aliases', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const configPath = box.path('auto-build.config.json');
  const config = json(configPath);
  config.modelIds = { 'Claude Opus 5.5': 'OPUS-CUSTOM' };
  write(configPath, config);
  const cdFile = box.path('auto-build-cooldowns.json');
  const future = new Date(NOW + 60_000).toISOString();
  write(cdFile, {
    'claude-opus-5-5': { until: 'invalid' },
    'model:antigravity:Claude Opus 5.5': { scope: 'model', until: future },
    'model:antigravity:OPUS-CUSTOM': { scope: 'model', until: future },
    'model:claude:claude-opus-5-5': { scope: 'model', until: future },
    'tier:claudeAgent:fable': { scope: 'tier', until: future },
    'tier:claude-2:fable': { scope: 'tier', until: future },
  });
  const opts = { log: () => {} };

  const clearedModel = quotaClear(box.target, 'antigravity:claude-opus-5-5', opts).sort();
  assert.deepEqual(clearedModel, [
    'claude-opus-5-5',
    'model:antigravity:Claude Opus 5.5',
    'model:antigravity:OPUS-CUSTOM',
  ]);
  const afterModel = json(cdFile);
  assert.ok(afterModel['model:claude:claude-opus-5-5']);

  const clearedProvider = quotaClear(box.target, 'claude', opts);
  assert.deepEqual(clearedProvider, ['tier:claudeAgent:fable']);
  const afterProvider = json(cdFile);
  assert.ok(afterProvider['tier:claude-2:fable']);
});

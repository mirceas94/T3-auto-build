import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCooldowns } from '../hooks/_quota.mjs';
import { quotaClear, quotaSet } from '../lib/quota.mjs';
import { sandbox } from './helpers.mjs';

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

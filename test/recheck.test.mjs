import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { COOLDOWN_FILE, matchRetired } from '../hooks/_shared.mjs';
import { writeCooldowns } from '../hooks/_quota.mjs';
import { checkModels, markAvailability } from '../lib/discover.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { json, read, sandbox, write } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 26);
const HOUR = 3_600_000;
const iso = (offset) => new Date(NOW + offset).toISOString();
const STARTER = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const config = () => toConfig(resolveTiers({ claude: 'ultra', codex: 'free', antigravity: 'pro' }));
const lock = (hours) => ({
  scope: 'provider', window: 'weekly', until: iso(hours * HOUR), reason: 'test', source: 'manual',
});

function setup(t, locks) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3ab recheck '));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(configDir, COOLDOWN_FILE);
  if (locks) writeCooldowns(file, locks, { now: NOW });
  const probed = [];
  const check = (state, options = {}) => checkModels({
    configDir,
    config: config(),
    which: (name) => (['agy', 'antigravity'].includes(name) ? null : path.join(os.tmpdir(), name)),
    runner: () => ({ status: 0, stdout: '1.0.0', stderr: '' }),
    now: NOW,
    probe: async ({ candidates }) => {
      probed.push(candidates);
      return {
        results: Object.entries(candidates)
          .flatMap(([provider, models]) => models.map((model) => ({ provider, model, state }))),
      };
    },
    ...options,
  });
  const stored = () => (fs.existsSync(file) ? json(file) : {});
  return { configDir, file, check, probed, stored };
}

for (const tier of ['free', 'go']) {
  test(`codex ${tier} is a CLI tier with the starter roster and no warning`, () => {
    const resolved = resolveTiers({ codex: tier });
    assert.deepEqual(resolved.allowlist.Codex, STARTER);
    assert.deepEqual(resolved.warnings.filter((w) => w.startsWith('codex')), []);
    assert.equal(resolved.maxParallelBuilders, 1);
    for (const [slot, ladder] of Object.entries(resolved.ladders)) assert.ok(ladder.length > 0, slot);
    assert.equal(resolved.ladders.tier1[0], 'gpt-6-luna');
    assert.equal(resolved.ladders.builderA[0], 'gpt-5.6-terra');
    for (const model of STARTER) assert.equal(matchRetired(model), false, model);
  });
}

test('init renders a codex-free-only skill', (t) => {
  const box = sandbox(t);
  const res = box.cli('init', '--yes', '--codex-tier', 'free');
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /warning: codex/);
  assert.match(read(box.path('skills', 'auto-build', 'SKILL.md')), /gpt-5\.6-terra/);
});

test('recheckAfter is stamped only on locks longer than 6h', (t) => {
  const { stored } = setup(t, { 'provider:codex': lock(48), 'provider:claude': lock(5) });
  assert.equal(stored()['provider:codex'].setAt, iso(0));
  assert.equal(stored()['provider:codex'].recheckAfter, iso(6 * HOUR));
  assert.equal(stored()['provider:claude'].recheckAfter, undefined);
});

test('checkModels reports a status per configured model', async (t) => {
  const { check } = setup(t, { 'provider:codex': lock(48) });
  const { statuses } = await check('available');
  const byRef = Object.fromEntries(statuses.map(({ ref, status }) => [ref, status]));
  assert.equal(statuses.length, config().models.length);
  assert.equal(byRef['codex:gpt-6-luna'], 'rate-limited');
  assert.equal(byRef['claude:claude-sonnet-5-5'], 'available');
  assert.equal(byRef['claude:claude-fable-5-2'], 'skipped-scarce');
  const restricted = await check('plan-restricted', { refresh: true });
  assert.ok(restricted.statuses.some((s) => s.status === 'plan-restricted'));
});

test('a failed probe never reports unavailable, but a manual mark does', async (t) => {
  const { configDir, check } = setup(t);
  assert.ok((await check('unavailable', { refresh: true })).statuses.every((s) => s.status !== 'unavailable'));
  markAvailability({ configDir, ref: 'codex:GPT 6 Luna', status: 'unavailable', now: NOW });
  const { statuses } = await check('available', { refresh: true });
  assert.equal(statuses.find((s) => s.ref === 'codex:gpt-6-luna').status, 'unavailable');
});

test('the main probe skips locked providers', async (t) => {
  const { check, probed, stored } = setup(t, { 'provider:codex': lock(48) });
  await check('rate-limited', { refresh: true });
  assert.equal(probed.length, 1);
  assert.equal(probed[0].codex, undefined);
  assert.equal(stored()['provider:codex'].until, iso(48 * HOUR));
});

test('a due lock is probed with the cheapest model and cleared on success', async (t) => {
  const { check, probed, stored } = setup(t, { 'provider:codex': lock(48) });
  assert.deepEqual((await check('available')).rechecked, [], 'not due yet');
  probed.length = 0;
  const { rechecked } = await check('available', { now: NOW + 7 * HOUR });
  assert.deepEqual(rechecked.map((r) => [r.model, r.result]), [['gpt-6-luna', 'cleared']]);
  assert.deepEqual(probed[0], { codex: ['gpt-6-luna'] });
  assert.deepEqual(stored(), {});
});

test('--recheck-locks probes early and a rate limit advances recheckAfter', async (t) => {
  const { check, stored } = setup(t, { 'provider:codex': lock(48) });
  const { rechecked } = await check('rate-limited', { recheckLocks: true, now: NOW + HOUR });
  assert.equal(rechecked[0].result, 'still-locked');
  assert.equal(stored()['provider:codex'].recheckAfter, iso(7 * HOUR));
  assert.equal(stored()['provider:codex'].until, iso(48 * HOUR));
});

test('a hand-written lock is stamped, and without a CLI it is deferred to T3 and kept', async (t) => {
  const { file, check, stored } = setup(t);
  write(file, { 'provider:antigravity': lock(48) });
  assert.deepEqual((await check('available')).rechecked, []);
  const { rechecked } = await check('available', { now: NOW + 7 * HOUR });
  assert.deepEqual(rechecked.map((r) => [r.provider, r.model, r.result]), [['antigravity', 'gemini-4-hydrogen', 'via-t3']]);
  assert.ok(stored()['provider:antigravity']);
});

test('custom instance locks are left alone and a locked model is not the canary', async (t) => {
  const model = { ...lock(48), scope: 'model' };
  const { check, stored } = setup(t, {
    'provider:codex-2': lock(48), 'provider:antigravity': lock(48), 'model:antigravity:gemini-4-hydrogen': model,
  });
  const { rechecked } = await check('available', { recheckLocks: true });
  assert.deepEqual(rechecked.map((r) => [r.key, r.model]), [['provider:antigravity', 'gemini-4-neon']]);
  assert.ok(stored()['provider:codex-2']);
});

test('the CLI prints statuses and recheck-via-t3, and quota clear accepts provider:<p>', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--antigravity-tier', 'pro').status, 0);
  // Empty PATH: no provider CLI can be run from this test.
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') box.env[key] = box.dir;
  assert.equal(box.cli('quota', 'set', 'antigravity', '--weekly').status, 0);
  const checked = box.cli('check-models', '--recheck-locks');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /^availability \w+; probed \d+; skipped scarce \d+/);
  assert.match(checked.stdout, /^antigravity:gemini-4-neon rate-limited$/m);
  assert.match(checked.stdout, /^recheck-via-t3: antigravity \(gemini-4-hydrogen\)$/m);
  const cleared = box.cli('quota', 'clear', 'provider:antigravity');
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /cleared: provider:antigravity/);
  assert.equal(box.cli('quota', 'clear', 'provider:nope').status, 2);
  for (const bad of ['claude-opus-5-5', 'codex:gpt-6-luna', 'codex-gpt-6-luna', 'claudefoo']) {
    assert.equal(box.cli('quota', 'clear', `provider:${bad}`).status, 2, bad);
  }
});

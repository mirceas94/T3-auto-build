// Quota routing in preflight and the quota CLI. Provider readers are faked; PATH is emptied so no real CLI can run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { completeConfig, configProblem } from '../lib/install/plan.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { formatPreflight, runPreflight } from '../lib/preflight.mjs';
import { json, sandbox, write } from './helpers.mjs';

const HOUR = 3_600_000;
const NOW = Date.now();
const at = (ms) => new Date(NOW + ms).toISOString();

const config = () => {
  const base = toConfig(resolveTiers({ claude: 'max', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });
  base.ladders = {
    ...base.ladders,
    builderA: ['gpt-6.2-sol', 'claude-sonnet-5-5', 'gemini-4-neon'],
    auditorA: ['claude-opus-5-5', 'gpt-6.2-sol', 'gemini-4-carbon'],
    dualAudit: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  };
  return base;
};

function setup(t) {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'empty bin');
  fs.mkdirSync(bin);
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key];
  box.env.PATH = bin;
  const saved = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = saved; });
  write(box.path('auto-build.config.json'), config());
  write(box.path('auto-build-availability.json'), { schemaVersion: 1, checkedAt: at(0), ttlMs: 12 * HOUR, models: {} });
  box.preflight = (quota, extra = {}) => runPreflight({ configDir: box.target, cwd: box.dir, now: NOW, quota, ...extra });
  return box;
}

/** Fake readers: Codex through the RPC runner, Antigravity through the command runner. */
function readers(codexUsed, geminiLeft) {
  const resetsAt = Math.floor((NOW + 150 * 60_000) / 1000);
  return {
    rpcRunner: async () => ({
      ok: true,
      result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: codexUsed, windowDurationMins: 300, resetsAt } } } },
    }),
    which: (name) => (name === 'agy' ? 'agy' : null),
    runner: async () => ({
      status: 0, stdout: `Gemini Models\tFive Hour Limit Remaining\t${geminiLeft}%\t${at(150 * 60_000)}\n`,
    }),
  };
}

test('ladders follow quota pace, unknown counts as 100, and dualAudit stays cross-provider', async (t) => {
  const result = await setup(t).preflight(readers(90, 90));
  assert.deepEqual(result.ladders.builderA, ['gemini-4-neon', 'claude-sonnet-5-5', 'gpt-6.2-sol']);
  assert.deepEqual(result.ladders.dualAudit, ['claude-opus-5-5', 'gemini-4-carbon']);
  assert.equal(result.quota.stale, false);
  assert.equal(result.quota.checkedAt, at(0));
  assert.equal(result.quota.windows.length, 2);
  assert.ok(result.quota.scores['antigravity:standard'] > 100);
  assert.ok(result.quota.scores['codex:standard'] < 100);
  assert.equal(result.quota.scores['claude:standard'], null);
});

test('unknown quota keeps the ladder order', async (t) => {
  const result = await setup(t).preflight();
  assert.deepEqual(result.ladders.builderA, config().ladders.builderA);
  assert.deepEqual(result.quota.windows, []);
});

test('an exhausted window locks its provider; a cleared lock stays cleared on a cached read', async (t) => {
  const box = setup(t);
  const fresh = await box.preflight(readers(99, 90));
  assert.deepEqual(fresh.locks.map((lock) => lock.key), ['provider:codex']);
  assert.ok(!fresh.ladders.builderA.includes('gpt-6.2-sol'));
  fs.rmSync(box.path('auto-build-cooldowns.json'));
  assert.deepEqual((await box.preflight(readers(99, 90))).locks, []);
});

test('a hanging reader is cut off at the deadline and uses per-provider cache freshness for pace', async (t) => {
  const box = setup(t);
  // Seed cache with fresh codex (low pace) and stale antigravity (would otherwise win if treated fresh).
  write(box.path('auto-build-quota.json'), {
    schemaVersion: 1,
    checkedAt: at(-10_000),
    ttlMs: 300_000,
    providers: {
      codex: {
        status: 'ok',
        checkedAt: at(-10_000),
        windows: [{ provider: 'codex', pool: 'standard', windowMinutes: 300, remainingPct: 10, resetsAt: at(150 * 60_000) }],
      },
      antigravity: {
        status: 'ok',
        checkedAt: at(-400_000),
        windows: [{ provider: 'antigravity', pool: 'standard', windowMinutes: 300, remainingPct: 90, resetsAt: at(150 * 60_000) }],
      },
    },
  });
  const result = await box.preflight({ runner: () => new Promise(() => {}), deadlineMs: 50 });
  assert.equal(result.quota.stale, true);
  // Fresh codex window is scored (<100); stale antigravity window is excluded (null -> 100, keeps ladder order ahead of codex).
  assert.deepEqual(result.quota.windows.map((w) => w.provider), ['codex']);
  assert.ok(result.quota.scores['codex:standard'] < 100);
  assert.equal(result.quota.scores['antigravity:standard'], null);
  assert.deepEqual(result.ladders.builderA, ['claude-sonnet-5-5', 'gemini-4-neon', 'gpt-6.2-sol']);
});

test('a read cut off at the deadline writes no quota cache or lock when it finishes later', async (t) => {
  const box = setup(t);
  const live = readers(99, 90);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const late = {
    ...live,
    rpcRunner: async (...args) => { await gate; return live.rpcRunner(...args); },
    runner: async (...args) => { await gate; return live.runner(...args); },
    deadlineMs: 50,
  };
  const result = await box.preflight(late);
  assert.equal(result.quota.stale, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(box.path('auto-build-quota.json')), false);
  assert.equal(fs.existsSync(box.path('auto-build-cooldowns.json')), false);
});

test('config.quota is validated', () => {
  assert.equal(configProblem(completeConfig({ ...config(), quota: { minRemainingPct: 2.5, claudeUsage: true } })), null);
  for (const quota of [5, { minRemainingPct: 101 }, { ttlMs: 0 }, { ttlMs: -1 }, { claudeUsage: 'yes' }, { burstLockMs: 1.5 }]) {
    assert.match(configProblem(completeConfig({ ...config(), quota })), /^"quota"/);
  }
});

test('CLI: preflight --json carries quota; quota check takes its flags and rejects bad input', (t) => {
  const box = setup(t);
  const preflight = box.cli('preflight', '--json');
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.deepEqual(Object.keys(JSON.parse(preflight.stdout).quota), ['checkedAt', 'stale', 'windows', 'scores']);

  const failover = box.cli('quota', 'check', 'codex:gpt-6-luna', '--on-error', '--json');
  assert.equal(failover.status, 0, failover.stderr);
  assert.equal(JSON.parse(failover.stdout).action, 'failover');
  assert.match(box.cli('quota', 'check', 'codex', '--on-error').stdout, /^action: failover$/m);
  assert.equal(box.cli('quota', 'check', '--refresh', '--claude-usage').status, 0);

  assert.equal(box.cli('quota', 'check', '--on-error').status, 2);
  assert.equal(box.cli('quota', 'check', 'nonsense').status, 2);
  assert.equal(box.cli('quota', 'status', '--on-error').status, 2);
});

test('uninstall removes the quota cache and doctor flags a bad config.quota', (t) => {
  const box = setup(t);
  fs.rmSync(box.path('auto-build.config.json'));
  const init = box.cli('init', '--yes', '--claude-tier', 'pro');
  assert.equal(init.status, 0, init.stderr);
  write(box.path('auto-build.config.json'), { ...json(box.path('auto-build.config.json')), quota: { ttlMs: 'x' } });
  assert.match(box.cli('doctor').stdout, /"quota" must be/);
  write(box.path('auto-build-quota.json'), {});
  assert.equal(box.cli('uninstall').status, 0);
  assert.equal(fs.existsSync(box.path('auto-build-quota.json')), false);
});

test('a low known weekly quota on the parent adds a warning and keeps the parent', async (t) => {
  const box = setup(t);
  const parentConfig = { ...config(), parent: { model: 'opus', effort: 'medium' }, quota: { claudeUsage: true } };
  write(box.path('auto-build.config.json'), parentConfig);
  const run = async (usedPct, label = 'Current week (all models)') => {
    fs.rmSync(box.path('auto-build-quota.json'), { force: true });
    return box.preflight({
      which: () => null,
      runner: async () => ({ status: 0, stdout: `${label}: ${usedPct}% used · resets Dec 31, 11pm (UTC)
` }),
    });
  };
  const low = await run(88);
  assert.deepEqual(low.warnings, ['parent claude-opus-5-5: weekly quota 12% remaining; consider --budget']);
  assert.match(formatPreflight(low), /^warning: parent claude-opus-5-5: weekly quota 12% remaining; consider --budget$/m);
  assert.deepEqual((await run(80)).warnings, [], 'exactly 20%');
  assert.deepEqual((await run(50)).warnings, []);
  assert.deepEqual((await run(88, 'Current session')).warnings, [], 'non-weekly');
  fs.rmSync(box.path('auto-build-quota.json'), { force: true });
  const failing = { which: () => null, runner: async () => ({ status: 1, stdout: '' }) };
  assert.deepEqual((await box.preflight(failing)).warnings, [], 'unknown');
  write(box.path('auto-build.config.json'), { ...parentConfig, parent: null });
  assert.deepEqual((await run(88)).warnings, [], 'no parent');
});

test('parentWarnings ignores windows with resetsAt <= now and still reads/warns for parent under --<other>-only', async (t) => {
  const box = setup(t);
  const parentConfig = { ...config(), parent: { model: 'opus', effort: 'medium' }, quota: { claudeUsage: true } };
  write(box.path('auto-build.config.json'), parentConfig);

  // Expired (resetsAt < now and resetsAt === now) cached weekly windows must not trigger a warning.
  for (const offset of [-1000, 0]) {
    write(box.path('auto-build-quota.json'), {
      schemaVersion: 1,
      checkedAt: at(-5000),
      ttlMs: 300_000,
      providers: {
        claude: {
          status: 'ok',
          checkedAt: at(-5000),
          windows: [{ provider: 'claude', pool: 'standard', windowMinutes: 10_080, remainingPct: 5, resetsAt: at(offset) }],
        },
        codex: { status: 'unknown', checkedAt: at(-5000), windows: [] },
        antigravity: { status: 'unknown', checkedAt: at(-5000), windows: [] },
      },
    });
    const res = await box.preflight({ which: () => null });
    assert.deepEqual(res.warnings, [], `resetsAt offset ${offset}`);
  }

  // Under --codex-only, preflight still reads and warns for the Claude parent while keeping ladders codex-only.
  fs.rmSync(box.path('auto-build-quota.json'), { force: true });
  const codexOnly = await box.preflight({
    which: () => null,
    runner: async (bin) => (bin === 'claude'
      ? { status: 0, stdout: 'Current week (all models): 88% used · resets Dec 31, 11pm (UTC)\n' }
      : { status: 1, stdout: '' }),
  }, { flags: '--codex-only' });
  assert.deepEqual(codexOnly.warnings, ['parent claude-opus-5-5: weekly quota 12% remaining; consider --budget']);
  assert.ok(codexOnly.ladders.builderA.every((ref) => /^(codex:)?gpt-/.test(ref)));
});

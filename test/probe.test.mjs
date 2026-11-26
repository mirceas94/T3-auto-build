import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { classify, probeModels, syncModels } from '../lib/probe.mjs';
import { sandbox, tree, write, json } from './helpers.mjs';
import { doctor } from '../lib/doctor.mjs';
import { fileHash, readManifest } from '../lib/manifest.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { isLocked } from '../hooks/_quota.mjs';

const success = { status: 0, stdout: 'ok', stderr: '' };
const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

test('classify separates available, cooldown, plan restriction, and unavailable results', () => {
  assert.deepEqual(classify(success), { state: 'available', reason: 'ok' });
  assert.equal(classify(fail('429 rate limit')).state, 'rate-limited');
  assert.equal(classify(fail('model is not available on your current plan')).state, 'plan-restricted');
  assert.equal(classify(fail('please log in')).state, 'unavailable');
  assert.deepEqual(classify({ error: { code: 'ENOENT' } }), { state: 'unavailable', reason: 'cli not found' });
  assert.deepEqual(classify({ error: { code: 'ETIMEDOUT' } }, { timeout: 5000 }), { state: 'unavailable', reason: 'timed out after 5s' });
  assert.equal(classify(fail('limit reached')).state, 'rate-limited');
  assert.equal(classify(fail('no limit reached')).state, 'rate-limited'); // classification may detect rate text; quota check must not.
});

test('probeModels keeps probing after a model rate limit and attaches cooldown data', async () => {
  const calls = [];
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return calls.length === 1 ? fail('429 rate limit') : success;
  };
  const { results } = await probeModels({
    config: { allowlist: { claude: ['Claude Opus 5.5', 'Claude Sonnet 5.5'] }, tiers: { claude: { sharing: 'provider' } } },
    runner, now: Date.UTC(2026, 0, 1),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(results.map((r) => r.state), ['rate-limited', 'available']);
  assert.equal(results[0].cooldown.entry.scope, 'model');
  assert.equal(results[0].cooldown.entry.window, 'burst');
  assert.match(results[0].cooldown.key, /^model:/);
});

test('provider rate limit skips later probes and tier limits use a heavy tier key', async () => {
  let calls = 0;
  const provider = await probeModels({
    config: { allowlist: { codex: ['gpt-6-luna', 'gpt-5.6-luna'] }, tiers: { codex: { sharing: 'provider' } } },
    runner: async () => { calls += 1; return fail('weekly limit reached'); }, now: Date.UTC(2026, 0, 1),
  });
  assert.equal(calls, 1);
  assert.equal(provider.results[1].skipped, true);
  assert.equal(provider.results[0].cooldown.entry.scope, 'provider');

  const tier = await probeModels({
    config: { allowlist: { claude: ['Claude Opus 5.5'] }, tiers: { claude: { sharing: 'heavy-tier-only' } } },
    runner: async () => fail('5-hour limit reached'), now: Date.UTC(2026, 0, 1),
  });
  assert.equal(tier.results[0].cooldown.key, 'tier:claude:heavy');
  assert.equal(tier.results[0].cooldown.entry.scope, 'tier');
});

test('syncModels preserves custom config, records only plan restrictions, rerenders files and passes doctor', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const configFile = box.path('auto-build.config.json');
  const config = json(configFile);
  config.allowlist.claude = ['Claude Opus 5.5', 'Claude Sonnet 5.5'];
  config.customSetting = { keep: true };
  config.bannedModels.push('local-bad-model');
  config.compactionThreshold = 37;
  config.tiers = { claude: { plan: 'max', sharing: 'heavy-tier-only', heavyModels: ['Claude Opus 5.5'] } };
  write(configFile, config);
  const beforeSkill = fs.readFileSync(box.path('skills', 'auto-build', 'SKILL.md'), 'utf8');
  const answers = [success, fail('This model is not available on your current plan'), fail('5-hour limit reached')];
  const summary = await syncModels(box.target, {
    providers: ['claude'], now: Date.UTC(2026, 0, 1), yes: true,
    runner: async () => answers.shift() ?? success,
  });
  const saved = json(configFile);
  assert.deepEqual(saved.customSetting, { keep: true });
  assert.deepEqual(saved.bannedModels, config.bannedModels);
  assert.equal(saved.compactionThreshold, 37);
  assert.deepEqual(saved.tiers, config.tiers);
  const claudeKey = Object.keys(saved.allowlist).find((key) => key.toLowerCase() === 'claude');
  const restrictedKey = Object.keys(summary.planRestricted).find((key) => key.toLowerCase() === 'claude');
  assert.ok(saved.allowlist[claudeKey].includes('Claude Opus 5.5'));
  assert.ok(!saved.allowlist[claudeKey].includes('Claude Sonnet 5.5'));
  assert.ok(summary.planRestricted[restrictedKey].includes('Claude Sonnet 5.5'));
  assert.equal(summary.cooldowns['tier:claude:heavy'].scope, 'tier');
  assert.notEqual(fs.readFileSync(box.path('skills', 'auto-build', 'SKILL.md'), 'utf8'), beforeSkill);
  const manifest = readManifest(box.target);
  for (const [rel, digest] of Object.entries(manifest.files)) {
    if (rel === 'auto-build.config.json') continue; // Edited config remains user-owned in the manifest.
    assert.equal(fileHash(box.path(...rel.split('/'))), digest, rel);
  }
  const doctorMessages = [];
  const savedPath = process.env.PATH;
  const emptyPath = box.path('empty-cli-path');
  fs.mkdirSync(emptyPath);
  try {
    process.env.PATH = emptyPath;
    assert.equal(doctor(box.target, (line) => doctorMessages.push(line)), 0, doctorMessages.join('\n'));
  } finally {
    process.env.PATH = savedPath;
  }
});

test('syncModels on a v2 config probes only the tier allowlist and never lifts tier restrictions', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes', '--claude-tier', 'pro', '--codex-tier', 'plus').status, 0);
  const configFile = box.path('auto-build.config.json');
  const before = json(configFile);
  assert.equal(before.schemaVersion, 2);
  before.planRestrictedModels = ['codex:gpt-6.1-sol'];
  write(configFile, before);
  const probed = [];
  await syncModels(box.target, {
    providers: ['claude', 'codex'], now: Date.UTC(2026, 0, 1), yes: true,
    runner: async (cmd, args) => {
      probed.push(args.join(' '));
      return args.join(' ').includes('gpt-6.1-terra') ? fail('This model is not available on your current plan') : success;
    },
  });
  const saved = json(configFile);
  assert.ok(!probed.some((line) => /gpt-6\.1-sol|gpt-6-astra|fable/i.test(line)), probed.join('\n'));
  const listed = Object.values(saved.allowlist).flat().map((m) => m.toLowerCase());
  assert.ok(!listed.some((m) => /sol|astra|fable|gemini/.test(m)), listed.join(', '));
  assert.ok(!listed.includes('gpt-6.1-terra'));
  assert.ok(saved.planRestrictedModels.includes('codex:gpt-6.1-sol'));
  assert.ok(saved.planRestrictedModels.includes('codex:gpt-6.1-terra'));
  assert.equal(saved.planRestricted, undefined);
});

test('syncModels dry run probes but writes nothing', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  let probes = 0;
  const before = tree(box.target);
  const result = await syncModels(box.target, {
    dryRun: true, now: Date.UTC(2026, 0, 1),
    runner: async () => { probes += 1; return success; },
  });
  assert.ok(probes > 0);
  assert.deepEqual(tree(box.target), before);
});

test('syncModels refuses an empty effective allowlist without writing', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const configFile = box.path('auto-build.config.json');
  const config = json(configFile);
  config.allowlist = { claude: ['Claude Opus 5.5'] };
  config.allowlist = { claude: ['Claude Opus 5.5'] };
  config.bannedModels = ['Claude Opus 5.5', 'Claude Haiku 5.5', 'Claude Sonnet 5.5', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-luna', 'Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Gemini 4 Carbon'];
  write(configFile, config);
  const before = tree(box.target);
  await assert.rejects(syncModels(box.target, {
    yes: true, providers: ['claude'], runner: async () => success,
  }), /no allowed model would remain/);
  assert.deepEqual(tree(box.target), before);
});

const v2 = () => ({
  ...toConfig(resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' })),
  allowlist: { codex: ['gpt-6-luna', 'gpt-6-astra'], Antigravity: ['claude-opus-5-5'] },
});

test('probeModels reports scarce and unselected pools as skipped without running them', async () => {
  const ran = [];
  const runner = async (cmd, args) => { ran.push(args[args.indexOf('--model') + 1]); return success; };
  const { results } = await probeModels({ config: v2(), runner });
  assert.deepEqual(ran, ['gpt-6-luna']);
  assert.deepEqual(results.filter((r) => r.skipped).map((r) => r.model), ['gpt-6-astra', 'claude-opus-5-5']);

  ran.length = 0;
  await probeModels({ config: v2(), runner, probeScarce: true });
  assert.deepEqual(ran, ['gpt-6-luna', 'gpt-6-astra']);

  ran.length = 0;
  await probeModels({ config: v2(), runner, probeScarce: true, pools: ['astra'] });
  assert.deepEqual(ran, ['gpt-6-astra']);
});

test('probe cooldown keys use v2 pools and lock exactly the refused hosting', async () => {
  const now = Date.UTC(2026, 0, 1);
  const config = v2();
  const lockFor = async (provider, model, message) => (await probeModels({
    config, candidates: { [provider]: [model] }, probeScarce: true, runner: async () => fail(message), now,
  })).results[0].cooldown;

  const weekly = await lockFor('codex', 'gpt-6-astra', 'weekly limit reached');
  assert.equal(weekly.key, 'tier:codex:astra');
  assert.equal(weekly.entry.tier, 'astra');
  const locks = { [weekly.key]: weekly.entry };
  assert.ok(isLocked(locks, { provider: 'codex', model: 'gpt-6-astra', config }, now));
  assert.equal(isLocked(locks, { provider: 'codex', model: 'gpt-6-luna', config }, now), null);

  const burst = await lockFor('claude', 'claude-sonnet-5-5', '429 rate limit');
  assert.equal(burst.key, 'model:claude:claude-sonnet-5-5');
  const hosted = { [burst.key]: burst.entry };
  assert.ok(isLocked(hosted, { provider: 'claude', model: 'claude-sonnet-5-5', config }, now));
  assert.equal(isLocked(hosted, { provider: 'antigravity', model: 'claude-sonnet-5-5', config }, now), null);
});

test('syncModels passes caller now to writeCooldowns and keeps the longest lock per key in a single run', async (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const configFile = box.path('auto-build.config.json');
  const config = json(configFile);
  config.allowlist = { claude: ['Claude Opus 5.5', 'Claude Sonnet 5.5'] };
  config.tiers = { claude: { plan: 'max', sharing: 'heavy-tier-only', heavyModels: ['Claude Opus 5.5', 'Claude Sonnet 5.5'] } };
  write(configFile, config);

  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const responses = [
    fail('5-hour limit reached, resets 2026-01-03T12:00:00Z'),
    fail('5-hour limit reached, try again in 2h'),
  ];
  await syncModels(box.target, {
    providers: ['claude'], yes: true, now,
    runner: async () => responses.shift(),
    log: () => {},
  });
  const stored = json(box.path('auto-build-cooldowns.json'))['tier:claude:heavy'];
  assert.equal(stored.until, '2026-01-03T12:00:00.000Z');
  assert.equal(stored.setAt, new Date(now).toISOString());
  assert.equal(stored.recheckAfter, new Date(now + 6 * 3_600_000).toISOString());
});

test('probeModels rejects an unknown provider with CliError exitCode 2', async () => {
  await assert.rejects(
    probeModels({ config: { allowlist: { claude: ['Claude Opus 5.5'] } }, providers: ['nope'] }),
    (error) => error.exitCode === 2 && /unknown provider/.test(error.message),
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { classify, probeModels, syncModels } from '../lib/probe.mjs';
import { sandbox, tree, write, json } from './helpers.mjs';
import { doctor } from '../lib/doctor.mjs';
import { fileHash, readManifest } from '../lib/manifest.mjs';

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

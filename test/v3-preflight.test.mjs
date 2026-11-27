import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { which } from '../hooks/_shared.mjs';
import { fileHash } from '../lib/manifest.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { formatPreflight, runPreflight } from '../lib/preflight.mjs';
import { LADDERS } from '../lib/render.mjs';
import { json, sandbox, tree, write } from './helpers.mjs';

const HOUR = 3_600_000;
const NOW = Date.now();
const GIT = which('git');
const at = (ms) => new Date(NOW + ms).toISOString();
const lock = (scope, extra = {}) => ({ scope, window: '5h', until: at(HOUR), reason: 'cap', source: 'auto', ...extra });
const v3Config = () => toConfig(resolveTiers({ claude: 'max', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });

/**
 * A config dir with a fresh availability cache. PATH is emptied, so no real provider CLI is ever run: a subprocess gets
 * box.env, and an in-process call gets the swapped process.env.PATH.
 */
function setup(t, { config = v3Config(), cooldowns, availability = {}, git = false } = {}) {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'empty bin');
  fs.mkdirSync(bin);
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key];
  const saved = process.env.PATH;
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = git && GIT ? path.dirname(GIT) : bin;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(box.dir);
  t.after(() => {
    process.env.PATH = saved;
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });
  box.env.PATH = bin;
  write(box.path('auto-build.config.json'), config);
  write(box.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: at(0), ttlMs: 12 * HOUR, models: availability,
  });
  if (cooldowns) write(box.path('auto-build-cooldowns.json'), cooldowns);
  box.preflight = (options = {}) => runPreflight({ configDir: box.target, cwd: box.dir, now: NOW, ...options });
  return box;
}

const refs = (result) => Object.values(result.ladders).flat().map((ref) => ref.split('@')[0]);

test('resolves every ladder with a config hash, expiry and empty state', async (t) => {
  const box = setup(t);
  const result = await box.preflight();
  assert.equal(result.version, 1);
  assert.equal(result.generatedAt, at(0));
  assert.equal(result.expiresAt, at(12 * HOUR));
  assert.equal(result.configHash, fileHash(box.path('auto-build.config.json')));
  assert.deepEqual(result.subscriptions, v3Config().subscriptions);
  assert.deepEqual(Object.keys(result.ladders), LADDERS);
  for (const [slot, entries] of Object.entries(result.ladders)) assert.ok(entries.length > 0, slot);
  assert.deepEqual([result.locks, result.canaries, result.baseline, result.resume], [[], [], [], null]);

  const text = formatPreflight(result);
  assert.match(text, /^locks: none$/m);
  assert.match(text, /^subscriptions: claude: max, codex: pro-200, antigravity: pro$/m);
  assert.match(text, /^baseline: clean or not a git repo$/m);
  assert.match(text, /^resume: no state file$/m);
});

test('expiresAt follows preflight.ttl or the first lock to lift; the hash follows the config', async (t) => {
  const short = setup(t, { config: { ...v3Config(), preflight: { ttl: 1000 } } });
  const first = await short.preflight();
  assert.equal(first.expiresAt, at(1000));
  write(short.path('auto-build.config.json'), { ...v3Config(), preflight: { ttl: 2000 } });
  assert.notEqual((await short.preflight()).configHash, first.configHash);

  const locked = setup(t, { cooldowns: { 'provider:codex': lock('provider') } });
  assert.equal((await locked.preflight()).expiresAt, at(HOUR));
});

test('active locks, restrictions and retired models leave the ladders; expired locks do not', async (t) => {
  const config = v3Config();
  config.planRestrictedModels = ['claude-opus-5-5'];
  config.ladders.tier1 = ['gpt-5.4', 'not-listed', 'gpt-6-luna', 'claude-haiku-5-5'];
  const box = setup(t, {
    config,
    availability: { 'claude:claude-sonnet-5-5': { status: 'unavailable', until: at(2 * HOUR) } },
    cooldowns: {
      'provider:codex': lock('provider', { reason: 'weekly\ncap' }),
      'provider:claude': lock('provider', { until: at(-HOUR) }),
    },
  });
  const result = await box.preflight();
  assert.deepEqual(result.locks.map((entry) => [entry.key, entry.reason]), [['provider:codex', 'weekly cap']]);
  assert.deepEqual(result.ladders.tier1, ['claude-haiku-5-5']);
  for (const ref of refs(result)) assert.doesNotMatch(ref, /^(codex:)?gpt-|^claude-sonnet-5-5$|^claude-opus-5-5$/, ref);
  assert.match(formatPreflight(result), /^ {2}provider:codex until .* \(weekly cap\)$/m);
});

test('an exhausted ladder stays empty and says so', async (t) => {
  const config = v3Config();
  config.ladders.tier1 = ['gpt-6-luna'];
  const box = setup(t, { config, cooldowns: { 'provider:codex': lock('provider') } });
  const result = await box.preflight();
  assert.deepEqual(result.ladders.tier1, []);
  assert.match(formatPreflight(result), /^ {2}tier1: \(exhausted\)$/m);
});

test('--<provider>-only flags restrict every ladder', async (t) => {
  const box = setup(t);
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const result = await box.preflight({ flags: `--strict --${provider}-only` });
    const found = refs(result);
    assert.ok(found.length > 0, provider);
    const prefix = { claude: /^(claude:)?claude-/, codex: /^(codex:)?gpt-/, antigravity: /^(antigravity:|gemini-)/ }[provider];
    for (const ref of found) assert.match(ref, prefix, `${provider} ${ref}`);
  }
});

test('a due provider lock without a local CLI is reported as a canary', async (t) => {
  const cooldowns = {
    'provider:codex': lock('provider', { recheckAfter: at(-1000) }),
    'tier:codex:astra': lock('tier'),
  };
  const box = setup(t, { cooldowns });
  const result = await box.preflight();
  assert.equal(result.canaries.length, 1);
  const [canary] = result.canaries;
  assert.equal(canary.provider, 'codex');
  assert.equal(canary.key, 'provider:codex');
  assert.equal(canary.until, at(HOUR));
  assert.deepEqual(canary.poolLocks, [{ key: 'tier:codex:astra', until: at(HOUR) }]);
  assert.match(formatPreflight(result), new RegExp(`^recheck-via-t3: codex \\(${canary.model}\\)$`, 'm'));
  for (const flags of ['--dry-run', '--claude-only']) assert.deepEqual((await box.preflight({ flags })).canaries, [], flags);
});

test('resume state is validated', async (t) => {
  const box = setup(t);
  const state = path.join(box.dir, '.claude', 'auto-build-state.json');
  write(state, { completedWaves: ['1'], remaining: ['2', '3'] });
  const good = await box.preflight();
  assert.deepEqual(good.resume, {
    valid: true,
    file: state,
    state: { flags: [], completedWaves: ['1'], modifiedFiles: [], remaining: ['2', '3'], blockers: [] },
  });
  assert.match(formatPreflight(good), /^resume: 1 waves done, 2 remaining, 0 blockers/m);
  for (const [content, reason] of [['{ nope', /unreadable/], ['[]', /not a JSON object/], ['{"flags":"--fast"}', /non-array field\(s\): flags/]]) {
    write(state, content);
    const bad = await box.preflight();
    assert.equal(bad.resume.valid, false, content);
    assert.match(bad.resume.error, reason);
    assert.match(formatPreflight(bad), /^resume: invalid state file/m);
  }
});

test('the baseline lists git changes', { skip: !GIT && 'git is not installed' }, async (t) => {
  const box = setup(t, { git: true });
  const repo = path.join(box.dir, 'my repo');
  fs.mkdirSync(repo);
  assert.deepEqual((await box.preflight({ cwd: repo })).baseline, [], 'not a repository');
  assert.equal(spawnSync(GIT, ['-C', repo, 'init', '-q'], { env: box.env }).status, 0);
  write(path.join(repo, 'a.txt'), '1');
  const result = await box.preflight({ cwd: repo });
  assert.deepEqual(result.baseline, ['?? a.txt']);
  assert.match(formatPreflight(result), /^baseline: 1 changed\n {2}\?\? a\.txt$/m);
});

test('an unreadable config or lock file stops the run', async (t) => {
  const box = setup(t);
  write(box.path('auto-build-cooldowns.json'), '{ nope');
  await assert.rejects(box.preflight(), /cannot be read/);
  write(box.path('auto-build.config.json'), '[]');
  await assert.rejects(box.preflight(), /not a JSON object/);
  write(box.path('auto-build.config.json'), '{ nope');
  await assert.rejects(box.preflight(), /cannot read valid config JSON/);
});

test('a corrupt lock file stops the run before any probe, even with a stale cache', async (t) => {
  const box = setup(t);
  write(box.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: '2000-01-01T00:00:00.000Z', ttlMs: 12 * HOUR, models: {},
  });
  write(box.path('auto-build-cooldowns.json'), '{ nope');
  const calls = [];
  const probe = async (options) => {
    calls.push(options);
    return { results: [] };
  };
  const before = tree(box.target);
  await assert.rejects(box.preflight({ probe }), /cannot be read/);
  assert.equal(calls.length, 0);
  assert.deepEqual(tree(box.target), before);
});

test('a v2 config still preflights', async (t) => {
  const box = setup(t, { config: { ...v3Config(), schemaVersion: 2 } });
  assert.ok(refs(await box.preflight()).length > 0);
});

test('CLI preflight prints JSON or text and checks --cwd', (t) => {
  const box = setup(t, { cooldowns: { 'provider:codex': lock('provider') } });
  const result = box.cli('preflight', '--json', '--flags', '--claude-only --dry-run', '--cwd', box.dir);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.configHash, fileHash(box.path('auto-build.config.json')));
  assert.deepEqual(parsed.locks.map((entry) => entry.key), ['provider:codex']);
  for (const ref of refs(parsed)) assert.match(ref, /claude-/);

  const before = tree(box.target);
  const text = box.cli('preflight');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^preflight \d{4}-/);
  assert.deepEqual(json(box.path('auto-build.config.json')), JSON.parse(before['auto-build.config.json']));

  const missing = box.cli('preflight', '--cwd', path.join(box.dir, 'missing'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--cwd is not a directory/);
});

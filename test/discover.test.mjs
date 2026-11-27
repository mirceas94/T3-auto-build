import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyDrift, checkModels, discover, markAvailability, parseFamily, parseTtl, readAvailabilityFile, writeAvailability,
} from '../lib/discover.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { AVAILABILITY_FILE, COOLDOWN_FILE, restrictedBy } from '../hooks/_shared.mjs';
import { json, write } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 26);
const HOUR = 3_600_000;
const iso = (offset) => new Date(NOW + offset).toISOString();
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const none = () => null;
const found = (name) => path.join(os.tmpdir(), name);
const config = () => toConfig(resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' }));

function dir(t) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 't3ab discover '));
  t.after(() => fs.rmSync(made, { recursive: true, force: true, maxRetries: 5 }));
  return made;
}

/** A probe that reports every candidate as available and records what it was asked. */
function fakeProbe() {
  const calls = [];
  const probe = async (options) => {
    calls.push(options);
    const results = Object.entries(options.candidates)
      .flatMap(([provider, models]) => models.map((model) => ({ provider, model, state: 'available' })));
    return { results };
  };
  return { probe, calls };
}

test('parseTtl accepts m, h and d up to 30 days only', () => {
  assert.equal(parseTtl(), 24 * HOUR);
  assert.equal(parseTtl('24h'), 24 * HOUR);
  assert.equal(parseTtl('30m'), HOUR / 2);
  assert.equal(parseTtl('30d'), 720 * HOUR);
  for (const bad of ['0h', '31d', '5', '-1h', '1w', '', '1.5h', `${'9'.repeat(400)}d`, 5]) {
    assert.throws(() => parseTtl(bad), /invalid ttl/, String(bad));
  }
});

test('parseFamily reads known and new ids', () => {
  assert.deepEqual(parseFamily('gpt-6.1-sol'), { family: 'gpt-sol', version: '6.1' });
  assert.deepEqual(parseFamily('claude-sonnet-5-5'), { family: 'claude-sonnet', version: '5.5' });
  assert.deepEqual(parseFamily('gemini-4-neon'), { family: 'gemini-neon', version: '4' });
  assert.deepEqual(parseFamily('gpt-7-nova'), { family: 'gpt-nova', version: '7' });
  assert.deepEqual(parseFamily('claude-opus-6-20270101'), { family: 'claude-opus', version: '6' });
  assert.deepEqual(parseFamily('Claude Opus 5.6'), { family: 'claude-opus', version: '5.6' });
  assert.equal(parseFamily('o3'), null);
  assert.equal(parseFamily(undefined), null);
});

test('discover is bounded by timeoutMs and runs nothing but version checks and configured adapters', async () => {
  const calls = [];
  const runner = (cmd, args) => { calls.push([cmd, ...args]); return new Promise(() => {}); };
  const started = Date.now();
  const result = await discover({
    config: { ...config(), discovery: { codex: ['lister', 'models'] } }, runner, which: found, timeoutMs: 200,
  });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(calls.sort(), [
    ['antigravity', '--version'], ['claude', '--version'], ['codex', '--version'], ['lister', 'models'],
  ]);
  assert.deepEqual(result.binaries.codex, { found: true, version: null });
  // A silent adapter must not report every configured model as missing.
  assert.deepEqual([result.models, result.discoveredNew, result.missingConfigured], [{}, [], []]);
});

test('discover reports drift, missing models and versions', async () => {
  const listing = {
    codex: ['gpt-6.3-sol', 'gpt-7-nova', 'gpt-6-luna', 'bad id; rm -rf', 'gpt-5.5'],
    // Cross-hosted Claude models are configured for antigravity but never counted as missing.
    antigravity: ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-carbon'],
  };
  const runner = async (cmd, args) => {
    if (args[0] === '--version') return ok(`${cmd}-cli 1.2.3 (build)`);
    return ok(cmd === 'list-codex' ? JSON.stringify(listing.codex) : listing.antigravity.join('\r\n'));
  };
  const result = await discover({
    config: { ...config(), discovery: { codex: ['list-codex'], antigravity: ['list-agy'] } },
    runner, which: (name) => (name === 'claude' ? null : name), now: NOW,
  });
  assert.deepEqual(result.binaries.claude, { found: false, version: null });
  assert.deepEqual(result.binaries.codex, { found: true, version: '1.2.3' });
  assert.deepEqual(result.discoveredNew, [
    { provider: 'codex', model: 'gpt-6.3-sol', family: 'gpt-sol', version: '6.3', supersedes: 'gpt-6.2-sol' },
    { provider: 'codex', model: 'gpt-7-nova', family: 'gpt-nova', version: '7' },
    { provider: 'codex', model: 'gpt-5.5', family: null, version: null },
  ]);
  assert.deepEqual(result.missingConfigured, ['codex:gpt-6.1-terra', 'codex:gpt-6.1-sol', 'codex:gpt-6.2-sol', 'codex:gpt-6-astra', 'codex:gpt-6.2-astra']);
  assert.deepEqual(result.models['codex:gpt-6-luna'], { status: 'available', source: 'discover', checkedAt: iso(0) });
});

test('discover default runner lists through a real process and a .cmd shim, and kills a hung one', async (t) => {
  const run = (argv, timeoutMs = 10_000) => discover({
    config: { ...config(), discovery: { codex: argv } }, which: none, timeoutMs,
  });
  const listed = await run([process.execPath, '-e', "console.log('gpt-6.3-sol')"]);
  assert.equal(listed.discoveredNew[0]?.model, 'gpt-6.3-sol');
  if (process.platform === 'win32') {
    const shim = path.join(dir(t), 'list.cmd');
    write(shim, '@echo gpt-6.3-sol\r\n');
    assert.equal((await run([shim])).discoveredNew[0]?.model, 'gpt-6.3-sol');
  }
  const started = Date.now();
  const hung = await run([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], 300);
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(hung.discoveredNew, []);
});

test('checkModels probes standard models only when stale or refreshed', async (t) => {
  const configDir = dir(t);
  const { probe, calls } = fakeProbe();
  const check = (options) => checkModels({ configDir, config: config(), which: none, now: NOW, probe, ...options });
  const scarce = ['claude:claude-fable-5-2', 'codex:gpt-6-astra', 'antigravity:claude-opus-5-5'];

  const first = await check();
  assert.equal(first.stale, true);
  assert.equal(calls.length, 1);
  assert.ok(first.probed.includes('codex:gpt-6.1-sol'));
  for (const ref of scarce) {
    assert.ok(!first.probed.includes(ref), ref);
    assert.ok(first.skippedScarce.includes(ref), ref);
  }
  assert.deepEqual(json(path.join(configDir, AVAILABILITY_FILE)), first.availability);

  const fresh = await check({ now: NOW + HOUR });
  assert.deepEqual([fresh.stale, fresh.probed, calls.length], [false, [], 1]);
  assert.equal(fresh.availability.checkedAt, iso(0)); // discovery alone does not renew the cache

  const forced = await check({ now: NOW + HOUR, refresh: true, probeScarce: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].probeScarce, true);
  for (const ref of scarce) assert.ok(forced.probed.includes(ref), ref);
  assert.deepEqual(forced.skippedScarce, []);

  assert.equal((await check({ now: NOW + 14 * HOUR })).stale, true);
  assert.equal(calls.length, 3);
});

test('checkModels default probe never spends scarce quota or records unavailable', async (t) => {
  const configDir = dir(t);
  const ran = [];
  const runner = async (cmd, args) => {
    ran.push(args[args.indexOf('--model') + 1]);
    return { status: 1, stdout: '', stderr: 'please log in' };
  };
  const result = await checkModels({ configDir, config: config(), runner, which: none, now: NOW });
  assert.ok(ran.includes('gpt-6.1-sol'));
  assert.ok(!ran.includes('gpt-6-astra') && !ran.includes('claude-fable-5-2'));
  assert.deepEqual(result.availability.models, {});
});

test('checkModels prunes expired state, keeps live marks and stores probe cooldowns', async (t) => {
  const configDir = dir(t);
  write(path.join(configDir, COOLDOWN_FILE), {
    'provider:codex': { scope: 'provider', until: iso(-HOUR) },
    'provider:claude': { scope: 'provider', until: iso(HOUR) },
  });
  writeAvailability(configDir, {
    checkedAt: iso(-48 * HOUR),
    ttlMs: 12 * HOUR,
    models: {
      'codex:gpt-6-luna': { status: 'unavailable', source: 'mark', until: iso(2 * HOUR) },
      'codex:gpt-6.1-sol': { status: 'unavailable', source: 'mark', until: iso(-HOUR) },
      'claude:claude-opus-5-5': { status: 'plan-restricted', source: 'probe' },
    },
  });
  const lock = { key: 'tier:codex:astra', entry: { scope: 'tier', until: iso(4 * HOUR) } };
  const probe = async ({ candidates }) => ({
    results: Object.entries(candidates).flatMap(([provider, models]) => models.map((model) => ({
      provider, model, state: model === 'claude-opus-5-5' ? 'unavailable' : 'available',
      ...(model === 'gpt-6.1-terra' && { cooldown: lock }),
    }))),
  });
  const { availability } = await checkModels({ configDir, config: config(), which: none, now: NOW, probe });
  assert.equal(availability.models['codex:gpt-6-luna'].source, 'mark');
  assert.equal(availability.models['codex:gpt-6.1-sol'].status, 'available');
  // An inconclusive probe keeps what was known.
  assert.equal(availability.models['claude:claude-opus-5-5'].status, 'plan-restricted');
  const cooldowns = json(path.join(configDir, COOLDOWN_FILE));
  assert.deepEqual(Object.keys(cooldowns).sort(), ['provider:claude', 'tier:codex:astra']);

  // A fresh run still drops overrides and locks once they expire.
  const later = await checkModels({ configDir, config: config(), which: none, now: NOW + 5 * HOUR, probe });
  assert.equal(later.stale, false);
  assert.equal(later.availability.models['codex:gpt-6-luna'], undefined);
  assert.ok(!fs.existsSync(path.join(configDir, COOLDOWN_FILE)));
});

test('markAvailability writes a canonical override at once and rejects bad input', async (t) => {
  const configDir = dir(t);
  writeAvailability(configDir, {
    checkedAt: iso(0), ttlMs: 12 * HOUR,
    models: { 'Antigravity:Claude Opus 5.5': { status: 'plan-restricted', source: 'probe' } },
  });
  const entry = markAvailability({
    configDir, ref: 'antigravity:claude-opus-5-5', status: 'available', ttl: '2h', reason: 'upgraded\nplan', now: NOW,
  });
  assert.deepEqual(entry, {
    status: 'available', source: 'mark', checkedAt: iso(0), until: iso(2 * HOUR), reason: 'upgraded plan',
  });
  const stored = readAvailabilityFile(configDir);
  assert.deepEqual(Object.keys(stored.models), ['antigravity:claude-opus-5-5']);
  assert.equal(restrictedBy(stored, 'antigravity', 'claude-opus-5-5', NOW), null);
  markAvailability({ configDir, ref: 'claudeAgent:claude-opus-5-5', status: 'unavailable', now: NOW });
  assert.ok(restrictedBy(readAvailabilityFile(configDir), 'claude', 'claude-opus-5-5', NOW));

  const before = fs.readFileSync(path.join(configDir, AVAILABILITY_FILE), 'utf8');
  const bad = [
    { ref: 'work:gpt-6-luna' }, { ref: 'gpt-6-luna' }, { ref: 'codex:' }, { ref: 'codex:  ' }, { ref: 'codex:a\nb' },
    { status: 'ok' }, { ttl: '0h' }, { ttl: '31d' },
  ];
  for (const change of bad) {
    assert.throws(() => markAvailability({
      configDir, ref: 'codex:gpt-6-luna', status: 'available', now: NOW, ...change,
    }), /invalid/, JSON.stringify(change));
  }
  assert.equal(fs.readFileSync(path.join(configDir, AVAILABILITY_FILE), 'utf8'), before);

  // A mark alone never makes the cache look probed.
  const empty = dir(t);
  markAvailability({ configDir: empty, ref: 'codex:gpt-6-luna', status: 'unavailable', now: NOW });
  const { probe, calls } = fakeProbe();
  const result = await checkModels({ configDir: empty, config: config(), which: none, now: NOW, probe });
  assert.equal(calls.length, 1);
  assert.equal(result.availability.models['codex:gpt-6-luna'].status, 'unavailable');
});

test('applyDrift replaces superseded models per hosting and changes nothing else', (t) => {
  const before = config();
  before.retiredModels.push('gemini-9-neon');
  const copy = structuredClone(before);
  const availability = {
    discoveredNew: [
      { provider: 'codex', model: 'gpt-6.3-sol', supersedes: 'gpt-6.1-sol' },
      { provider: 'codex', model: 'gpt-6.2-sol', supersedes: 'gpt-6.1-sol' },
      { provider: 'codex', model: 'gpt-6.1-astra', supersedes: 'gpt-6-astra' },
      { provider: 'antigravity', model: 'claude-opus-5-6', supersedes: 'claude-opus-5-5' },
      { provider: 'codex', model: 'gpt-7-nova' },
      // Hand-edited entries that must be ignored: wrong family, retired by default, retired by config.
      { provider: 'codex', model: 'gpt-7-nova', supersedes: 'gpt-6-luna' },
      { provider: 'codex', model: 'gpt-5.5', supersedes: 'gpt-6-luna' },
      { provider: 'antigravity', model: 'gemini-9-neon', supersedes: 'gemini-4-neon' },
    ],
  };
  const writes = [t.mock.method(fs, 'writeFileSync'), t.mock.method(fs, 'renameSync')];
  const { config: next, promoted, unknown } = applyDrift(before, availability);
  assert.deepEqual(writes.map((spy) => spy.mock.callCount()), [0, 0]);
  assert.deepEqual(before, copy);
  assert.deepEqual(promoted, [
    { provider: 'codex', from: 'gpt-6.1-sol', to: 'gpt-6.3-sol' },
    { provider: 'codex', from: 'gpt-6-astra', to: 'gpt-6.1-astra' },
    { provider: 'antigravity', from: 'claude-opus-5-5', to: 'claude-opus-5-6' },
  ]);
  assert.deepEqual(unknown, [{ provider: 'codex', model: 'gpt-7-nova' }]);

  const rename = (ref) => ref.replace('gpt-6.1-sol', 'gpt-6.3-sol').replace('gpt-6-astra', 'gpt-6.1-astra')
    .replace('antigravity:claude-opus-5-5', 'antigravity:claude-opus-5-6');
  assert.deepEqual(next.ladders, Object.fromEntries(Object.entries(copy.ladders).map(([k, v]) => [k, v.map(rename)])));
  assert.ok(Object.values(next.ladders).flat().some((ref) => ref.startsWith('antigravity:claude-opus-5-6@')));
  assert.ok(next.allowlist.Claude.includes('claude-opus-5-5'));
  assert.ok(next.allowlist.Antigravity.includes('claude-opus-5-6'));
  assert.ok(!next.allowlist.Codex.includes('gpt-6.1-sol'));
  const astra = next.models.find((m) => m.model === 'gpt-6.1-astra');
  assert.deepEqual([astra.pool, astra.scarceQuota, astra.version], ['astra', true, '6.1']);
  const hosted = next.models.find((m) => m.model === 'claude-opus-5-6');
  assert.deepEqual([hosted.provider, hosted.pool, hosted.scarceQuota], ['antigravity', 'third-party-claude', true]);
  // Applying the same data again finds nothing older left to replace.
  assert.deepEqual(applyDrift(next, availability).promoted, []);
});

test('checkModels staleness uses strict <, keeps live marks without until, and normalizes planRestrictedModels', async (t) => {
  const configDir = dir(t);
  const { probe, calls } = fakeProbe();
  const cfg = config();
  cfg.planRestrictedModels = ['Codex:GPT 6.1 Sol'];
  writeAvailability(configDir, {
    checkedAt: iso(-12 * HOUR),
    ttlMs: 12 * HOUR,
    models: {
      'codex:gpt-6-luna': { status: 'unavailable', source: 'mark' },
    },
  });
  // Exact boundary (age === ttlMs) must be stale, matching readAvailability().
  const res = await checkModels({ configDir, config: cfg, which: none, now: NOW, probe });
  assert.equal(res.stale, true);
  assert.equal(calls.length, 1);
  // A live mark without a parseable until must not be overwritten by a probe.
  assert.equal(res.availability.models['codex:gpt-6-luna'].source, 'mark');
  assert.equal(res.availability.models['codex:gpt-6-luna'].status, 'unavailable');
  // Normalized planRestrictedModels is recognized in statuses and applyDrift.
  assert.equal(res.statuses.find((s) => s.ref === 'codex:gpt-6.1-sol').status, 'plan-restricted');
  const driftCfg = config();
  driftCfg.planRestrictedModels = ['Codex:GPT 6.2 Sol'];
  const drifted = applyDrift(driftCfg, {
    discoveredNew: [{ provider: 'codex', model: 'gpt-6.2-sol', supersedes: 'gpt-6.1-sol' }],
  });
  assert.deepEqual(drifted.promoted, []);
});

test('restrictedBy and checkModels honor config.modelIds aliases', async (t) => {
  const configDir = dir(t);
  const { probe } = fakeProbe();
  const cfg = config();
  cfg.modelIds = { 'gpt-6-luna': 'luna-custom' };
  const avail = writeAvailability(configDir, {
    checkedAt: iso(0),
    ttlMs: 12 * HOUR,
    models: { 'codex:luna-custom': { status: 'unavailable', source: 'mark', until: iso(2 * HOUR) } },
  });
  assert.equal(restrictedBy(avail, 'codex', 'gpt-6-luna', NOW, cfg)?.status, 'unavailable');
  const res = await checkModels({ configDir, config: cfg, which: none, now: NOW, probe });
  assert.equal(res.statuses.find((s) => s.ref === 'codex:gpt-6-luna').status, 'unavailable');
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AVAILABILITY_FILE, CONFIG_FILE, DEFAULTS, RETIRED_MODELS, SCHEMA_VERSION, canonicalProvider, fastModeRequested, isV2,
  loadConfig, matchRetired, payloadProblem, readAvailability, resolveTarget, restrictedBy,
} from '../hooks/_shared.mjs';
import { sandbox, write } from './helpers.mjs';

test('matchRetired covers exact ids, families and display names only', () => {
  for (const model of [
    'gpt-5.4', 'gpt-5.4-mini', 'GPT 5.4 Mini', ' gpt-5.4 ', 'gpt-5.5-pro', 'claude-4.6', 'Claude 4.6', 'claude-4.6-opus',
    'claude-4.6-20260101', 'gemini-4-argon', 'Gemini 4 Argon', 'gemini-3.8-flash',
  ]) assert.equal(matchRetired(model), true, model);
  for (const model of [
    'gpt-5.40', 'gpt-5-4o', 'gpt-5.6-luna', 'gpt-6.1-sol', 'gemini-4-neon', 'gemini-4-argon-2', 'claude-opus-5-5', '',
    undefined, {},
  ]) assert.equal(matchRetired(model), false, String(model));
  assert.equal(matchRetired('x-1-mini', ['x-1-*']), true);
  assert.ok(Object.isFrozen(RETIRED_MODELS));
});

test('canonicalProvider maps aliases and instance ids', () => {
  const cases = {
    claudeAgent: 'claude', claude: 'claude', 'codex-2': 'codex', Antigravity: 'antigravity', work: null, openai: null,
  };
  for (const [id, provider] of Object.entries(cases)) assert.equal(canonicalProvider(id), provider, id);
  assert.equal(canonicalProvider(undefined), null);
});

describe('resolveTarget', () => {
  const hosted = { provider: 'antigravity', model: 'claude-sonnet-5-5', pool: 'third-party-claude', scarceQuota: true };
  const config = { models: [hosted] };
  const resolve = (providers, model, cfg = config) => resolveTarget({ providers, model }, cfg);
  const shape = (t) => [t.provider, t.pool, t.scarceQuota, t.crossHosted, t.entry, t.conflict];

  test('a bare model is native even when only a cross-hosted entry exists', () => {
    for (const providers of [[], ['work'], undefined]) {
      assert.deepEqual(shape(resolve(providers, 'claude-sonnet-5-5')), ['claude', 'standard', false, false, null, null]);
    }
  });

  test('an explicit provider with a declared entry is cross-hosted', () => {
    assert.deepEqual(
      shape(resolve(['antigravity'], 'Claude Sonnet 5.5')),
      ['antigravity', 'third-party-claude', true, true, hosted, null],
    );
  });

  test('undeclared hosting and mixed providers conflict; aliases cannot hide the provider', () => {
    assert.match(resolve(['antigravity'], 'claude-opus-5-5').conflict, /not hosted on provider antigravity/);
    assert.match(resolve(['antigravity'], 'claude-sonnet-5-5', {}).conflict, /not hosted/);
    assert.match(resolve(['codex', 'claude'], 'gpt-6-luna').conflict, /conflicting providers/);
    assert.equal(resolve(['claudeAgent', 'CLAUDE'], 'claude-opus-5-5').conflict, null);
    assert.equal(resolve(['work'], 'gpt-6-luna').provider, 'codex');
    assert.equal(resolve(['work', 'codex-2'], 'gpt-6-luna').provider, 'codex');
    assert.equal(resolve(['codex'], 'my-model').provider, 'codex');
    assert.equal(resolve(['work'], 'my-model').provider, null);
    assert.equal(resolve(['codex'], undefined, { models: 'x' }).conflict, null);
    assert.equal(resolve(['codex'], { id: 'x' }, { models: [null, 3] }).provider, 'codex');
    assert.equal(resolve(null, 'gpt-6-luna').provider, 'codex');
  });
});

test('payloadProblem flags a named tool with a non-object input', () => {
  for (const input of [5, 'x', null, []]) assert.match(payloadProblem({ tool_name: 'Bash', tool_input: input }), /Bash/);
  assert.ok(payloadProblem({ Tool_Name: 'Bash', Tool_Input: 5 }));
  for (const fine of [
    null, [1], { tool_input: 5 }, { tool_name: '', tool_input: 5 }, { tool_name: 'Bash' },
    { tool_name: 'Bash', tool_input: {} },
  ]) assert.equal(payloadProblem(fine), null, JSON.stringify(fine));
});

test('fastModeRequested scans keys and option pairs to a fixed depth', () => {
  for (const input of [
    { fastMode: true }, { options: [{ id: 'fastMode', value: true }] }, { speed: 'ultrafast' },
    { target: { service_tier: 'Priority' } }, { 'fast-mode': 'fast' }, { options: [{ id: 'fastMode', value: 'true' }] },
  ]) assert.equal(fastModeRequested(input), true, JSON.stringify(input));
  for (const input of [
    { fastMode: false }, { options: [{ id: 'fastMode', value: false }] }, { speed: 'standard' }, { prompt: 'fast' },
    null, 'fast',
  ]) assert.equal(fastModeRequested(input), false, JSON.stringify(input));
  const nest = (levels) => (levels === 1 ? { fastMode: true } : { a: nest(levels - 1) });
  assert.equal(fastModeRequested(nest(6)), true);
  assert.equal(fastModeRequested(nest(7)), false);
});

describe('loadConfig', () => {
  const load = (t, content) => {
    const box = sandbox(t);
    if (content !== undefined) write(box.path(CONFIG_FILE), content);
    const messages = [];
    const spy = t.mock.method(process.stderr, 'write', (text) => messages.push(text));
    const config = loadConfig(box.target);
    spy.mock.restore();
    return { config, stderr: messages.join('') };
  };
  const extras = { retiredModels: [...RETIRED_MODELS], planRestrictedModels: [], models: [], allowFastModes: false };
  const fallback = { schemaVersion: 1, ...DEFAULTS, ...extras };

  test('a v1 file keeps its values and gets inert defaults', (t) => {
    const v1 = { allowlist: { Local: ['m'] }, bannedModels: ['evil'], tiers: { codex: {} }, modelIds: { m: 'm1' } };
    const { config, stderr } = load(t, {
      ...v1, retiredModels: [], allowFastModes: true, models: [{ provider: 'codex', model: 'm' }], userBannedModels: ['x'],
      subscriptions: {}, maxParallelBuilders: 2,
    });
    assert.deepEqual(config, { schemaVersion: 1, ...v1, ...extras });
    assert.equal(stderr, '');
  });

  test('a valid v2 file; retired models only grow and both ban lists apply', (t) => {
    const v2 = {
      schemaVersion: SCHEMA_VERSION, allowlist: { Codex: ['gpt-6-luna'] }, planRestrictedModels: ['codex:gpt-6-astra'],
      models: [{ provider: 'codex', model: 'gpt-6-luna' }], allowFastModes: true, subscriptions: { codex: 'plus' },
      maxParallelBuilders: 3,
    };
    const { config, stderr } = load(t, { ...v2, retiredModels: ['old-1'], userBannedModels: ['a'], bannedModels: ['b'] });
    assert.deepEqual(config, { ...v2, retiredModels: [...RETIRED_MODELS, 'old-1'], bannedModels: ['b', 'a'] });
    assert.equal(stderr, '');
    assert.ok(isV2(v2));
    assert.deepEqual(load(t, { schemaVersion: 2, retiredModels: [] }).config.retiredModels, [...RETIRED_MODELS]);
  });

  test('invalid v2 keys fall back one by one', (t) => {
    const { config, stderr } = load(t, {
      schemaVersion: 2, preset: 'claude-only', allowlist: 5, retiredModels: 'none', planRestrictedModels: 1,
      models: [{ model: 'x' }], allowFastModes: 'true', userBannedModels: {}, subscriptions: 1, maxParallelBuilders: -1,
    });
    assert.deepEqual(config, {
      schemaVersion: 2, allowlist: { Claude: DEFAULTS.allowlist.Claude }, bannedModels: [], ...extras,
    });
    assert.equal(stderr.match(/invalid "/g).length, 8);
  });

  test('unknown schemaVersion or a malformed file fails closed to DEFAULTS', (t) => {
    for (const schemaVersion of [3, '2', 1, null]) {
      const { config, stderr } = load(t, { schemaVersion, preset: 'claude-only', allowlist: { Any: ['gpt-4'] } });
      assert.deepEqual(config, fallback, String(schemaVersion));
      assert.match(stderr, /schemaVersion.*defaults/);
    }
    for (const bad of ['{ nope', '[]', 'null']) {
      const { config, stderr } = load(t, bad);
      assert.deepEqual(config, fallback, bad);
      assert.match(stderr, /defaults/);
    }
    assert.deepEqual(load(t).config, fallback);
  });
});

test('readAvailability never throws and reports staleness', (t) => {
  const file = sandbox(t).path(AVAILABILITY_FILE);
  const now = Date.parse('2026-01-02T00:00:00Z');
  const none = { data: null, stale: true };
  assert.deepEqual(readAvailability(file, now), none);
  for (const bad of ['{ nope', '[]', 'null', '{"schemaVersion": 9, "models": {}}', '{"schemaVersion": 1, "models": 3}']) {
    write(file, bad);
    assert.deepEqual(readAvailability(file, now), none, bad);
  }
  assert.deepEqual(readAvailability(undefined, now), none);
  const data = { schemaVersion: 1, checkedAt: '2026-01-01T23:00:00Z', models: {} };
  for (const [change, stale] of [
    [{}, false], [{ ttlMs: 60_000 }, true], [{ checkedAt: '2026-01-01T11:00:00Z' }, true], [{ checkedAt: 'soon' }, true],
  ]) {
    write(file, { ...data, ...change });
    assert.deepEqual(readAvailability(file, now), { data: { ...data, ...change }, stale }, JSON.stringify(change));
  }
});

test('restrictedBy honors status, hosting and until', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const data = {
    models: {
      'codex:gpt-6.1-sol': { status: 'plan-restricted' },
      'codex:gpt-6-luna': { status: 'unavailable', until: '2026-01-01T00:00:00Z' },
      'codex:gpt-6.1-terra': { status: 'unavailable', until: '2026-01-03T00:00:00Z' },
      'codex:gpt-6-astra': { status: 'unavailable', until: 'later' },
      'claude:claude-opus-5-5': { status: 'available' },
      'antigravity:claude-sonnet-5-5': { status: 'unavailable' },
      broken: null,
    },
  };
  const check = (provider, model) => restrictedBy(data, provider, model, now);
  assert.equal(check('codex', 'GPT 6.1 Sol'), data.models['codex:gpt-6.1-sol']);
  assert.equal(restrictedBy({ data, stale: true }, 'codex-2', 'gpt-6.1-sol', now)?.status, 'plan-restricted');
  assert.equal(check('codex', 'gpt-6-luna'), null);
  assert.ok(check('codex', 'gpt-6.1-terra'));
  assert.ok(check('codex', 'gpt-6-astra'));
  assert.equal(check('claude', 'claude-opus-5-5'), null);
  assert.equal(check('claude', 'claude-sonnet-5-5'), null);
  assert.ok(check('antigravity', 'claude-sonnet-5-5'));
  for (const empty of [null, {}, { models: 3 }]) assert.equal(restrictedBy(empty, 'codex', 'gpt-6.1-sol', now), null);
});

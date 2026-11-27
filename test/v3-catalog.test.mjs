import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG_OVERRIDES_FILE, RETIRED_MODELS, loadCatalogOverrides, validateCatalogOverrides } from '../hooks/_catalog.mjs';
import { loadConfig } from '../hooks/_shared.mjs';
import { sandbox, write } from './helpers.mjs';

const VALID = {
  models: [
    { provider: 'codex', model: 'gpt-7-nova', pool: 'standard', scarceQuota: false, family: 'gpt-nova', version: '7' },
    { provider: 'antigravity', model: 'claude-sonnet-5-5', pool: 'third-party-claude', crossHosted: true },
  ],
  retiredModels: ['old-1', 'older-*'],
  aliases: { 'Nova Seven': 'gpt-7-nova', 'Claude Opus 5.5': 'claude-opus-5-5' },
};

/** Invalid, and nothing but a well-formed retiredModels list survives. */
function rejected(raw, reason) {
  const result = validateCatalogOverrides(raw);
  assert.equal(result.valid, false, JSON.stringify(raw));
  assert.match(result.errors.join('; '), reason, JSON.stringify(raw));
  assert.deepEqual(Object.keys(result.overrides).filter((key) => key !== 'retiredModels'), []);
  return result;
}

test('valid overrides pass through unchanged', () => {
  assert.deepEqual(validateCatalogOverrides(VALID), { valid: true, overrides: VALID, errors: [] });
  assert.deepEqual(validateCatalogOverrides({}), { valid: true, overrides: {}, errors: [] });
});

test('wrong shapes and unknown keys are rejected', () => {
  for (const raw of [null, [], 'x', 3]) rejected(raw, /JSON object/);
  rejected({ allowlist: {} }, /unknown key/);
  rejected({ models: {} }, /"models" must be a list/);
  rejected({ retiredModels: 'old' }, /"retiredModels" must be/);
  rejected({ aliases: [] }, /"aliases" must be an object/);
  rejected({ models: [{ provider: 'codex' }] }, /needs "provider" and "model"/);
  rejected({ models: [{ provider: 'codex', model: 'gpt-7', extra: 1 }] }, /invalid model field/);
  rejected({ models: [{ provider: 'codex', model: 'gpt-7', pool: 'free' }] }, /invalid model field/);
});

test('an unknown provider is rejected', () => {
  rejected({ models: [{ provider: 'openai', model: 'gpt-7-nova' }] }, /invalid model field "provider"/);
});

test('built-in retired models cannot be brought back', () => {
  for (const model of ['gpt-5.4', 'GPT 5.5 Pro', 'claude-4.6-opus', 'gemini-4-argon']) {
    rejected({ retiredModels: [], models: [{ provider: 'codex', model, crossHosted: true }] }, /retired model cannot be added/);
    rejected({ aliases: { 'my-model': model } }, /retired model/);
  }
  rejected({ retiredModels: ['old-1'], models: [{ provider: 'codex', model: 'old-1' }] }, /retired model cannot be added/);
});

test('alias cycles are rejected', () => {
  rejected({ aliases: { a: 'b', b: 'a' } }, /alias cycle/);
  rejected({ aliases: { a: 'b', b: 'c', c: 'a' } }, /alias cycle/);
  rejected({ aliases: { a: 'a' } }, /alias cycle/);
  rejected({ aliases: { 'A One': 'b-two', 'b two': 'a-one' } }, /alias cycle/);
});

test('provider spoofing through models or aliases is rejected', () => {
  rejected({ models: [{ provider: 'codex', model: 'claude-opus-5-5' }] }, /native to claude/);
  rejected({ models: [{ provider: 'claude', model: 'gpt-9-future' }] }, /native to codex/);
  rejected({ aliases: { 'gpt-6-luna': 'claude-opus-5-5' } }, /spoofs/);
  rejected({ aliases: { 'claude-opus-5-5': 'claude-haiku-5-5' } }, /spoofs/);
  // Two harmless-looking links that join two providers.
  rejected({ aliases: { mine: 'gpt-6-luna', 'gemini-4-neon': 'mine' } }, /spoofs/);
  for (const text of ['{"__proto__":"gpt-6-luna"}', '{"constructor":"gpt-6-luna"}']) {
    rejected({ aliases: JSON.parse(text) }, /invalid alias/);
  }
});

test('a rejected file still tightens the retired list', () => {
  const result = rejected({ retiredModels: ['old-1'], models: 'x' }, /"models"/);
  assert.deepEqual(result.overrides, { retiredModels: ['old-1'] });
});

test('loadCatalogOverrides reads BOM and CRLF files and never throws', (t) => {
  const box = sandbox(t);
  const empty = { valid: true, overrides: {}, errors: [] };
  const file = box.path(CATALOG_OVERRIDES_FILE);
  assert.deepEqual(loadCatalogOverrides(box.target), empty, 'missing file');
  write(file, '﻿ \r\n');
  assert.deepEqual(loadCatalogOverrides(box.target), empty, 'blank file');
  write(file, `﻿${JSON.stringify(VALID, null, 2).replace(/\n/g, '\r\n')}\r\n`);
  assert.deepEqual(loadCatalogOverrides(box.target), { valid: true, overrides: VALID, errors: [] });
  write(file, '{ nope');
  const broken = loadCatalogOverrides(box.target);
  assert.equal(broken.valid, false);
  assert.deepEqual(broken.overrides, {});
  assert.match(broken.errors[0], /unreadable/);
});

function load(t, config, overrides) {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), config);
  if (overrides !== undefined) write(box.path(CATALOG_OVERRIDES_FILE), overrides);
  const messages = [];
  const spy = t.mock.method(process.stderr, 'write', (text) => messages.push(text));
  const loaded = loadConfig(box.target);
  spy.mock.restore();
  return { config: loaded, stderr: messages.join('') };
}

test('loadConfig merges retired models and aliases for v3; own modelIds win and models stay out', (t) => {
  const { config, stderr } = load(t, { schemaVersion: 3, modelIds: { 'Nova Seven': 'mine' } }, VALID);
  assert.deepEqual(config.retiredModels, [...RETIRED_MODELS, 'old-1', 'older-*']);
  assert.deepEqual(config.modelIds, { 'Nova Seven': 'mine', 'Claude Opus 5.5': 'claude-opus-5-5' });
  assert.deepEqual(config.models, []);
  assert.equal(stderr, '');
});

test('loadConfig warns on a rejected file and keeps only its retired models', (t) => {
  const { config, stderr } = load(t, { schemaVersion: 3 }, { retiredModels: ['old-1'], aliases: { a: 'a' } });
  assert.deepEqual(config.retiredModels, [...RETIRED_MODELS, 'old-1']);
  assert.equal(config.modelIds, undefined);
  assert.match(stderr, /ignoring catalog\.overrides\.json \(alias cycle\)/);
});

test('loadConfig ignores overrides when disabled or below v3', (t) => {
  for (const raw of [{ schemaVersion: 3, catalogOverrides: false }, { schemaVersion: 2 }, {}]) {
    const { config } = load(t, raw, VALID);
    assert.deepEqual(config.retiredModels, [...RETIRED_MODELS], JSON.stringify(raw));
    assert.equal(config.modelIds, undefined);
  }
});

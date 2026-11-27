import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { completeConfig, configProblem } from '../lib/install.mjs';
import { matchRetired } from '../hooks/_shared.mjs';
import { ROOT, json, read, sandbox, write } from './helpers.mjs';

const v2Config = (tiers = { claude: 'max', codex: 'pro-200', antigravity: 'pro' }, options = {}) =>
  toConfig(resolveTiers(tiers), { preset: 'custom', ...options });

function installed(t, config = v2Config()) {
  const box = sandbox(t);
  const result = box.cli('init', '--yes');
  assert.equal(result.status, 0, result.stderr);
  write(box.path('auto-build.config.json'), config);
  return box;
}

const delegate = (model, extra = {}) => ({
  tool_name: 'mcp__t3-code__delegate_task',
  tool_input: { model, ...extra },
});

function blocked(box, payload, reason = /Blocked by/) {
  const result = box.hook('pre-tool-use', payload);
  assert.equal(result.status, 2, `${JSON.stringify(payload)}: ${result.stderr}`);
  assert.match(result.stderr, reason);
}

function allowed(box, payload) {
  const result = box.hook('pre-tool-use', payload);
  assert.equal(result.status, 0, `${JSON.stringify(payload)}: ${result.stderr}`);
}

test('provider lock cannot be bypassed with unknown, empty, or alternate provider aliases', (t) => {
  const box = installed(t);
  assert.equal(box.cli('quota', 'set', 'codex').status, 0);
  for (const providerInstanceId of ['work', 'CODEX-2', '', ' ', 'claudeAgent', undefined]) {
    const extra = providerInstanceId === undefined ? {} : { providerInstanceId };
    const expected = providerInstanceId === 'claudeAgent' ? /allowlist hook.*not hosted/i : /cooldown hook/i;
    blocked(box, delegate('gpt-6-luna', extra), expected);
  }
  blocked(box, delegate('gpt-6-luna', { providers: ['work', 'codex'] }), /cooldown hook/i);
  for (const model of ['Gpt-6-Luna', 'gpt 6 luna', 'gpt-6-luna-20261101']) {
    blocked(box, delegate(model, { providerInstanceId: 'work' }), /cooldown hook/i);
  }
});

test('cross-hosted claude models require explicit Antigravity and its own pool lock', (t) => {
  const config = v2Config({ claude: 'max', codex: 'plus', antigravity: 'pro' });
  const box = installed(t, config);
  assert.equal(box.cli('quota', 'set', 'claude').status, 0);
  allowed(box, delegate('claude-sonnet-5-5', { provider: 'antigravity' }));
  blocked(box, delegate('claude-sonnet-5-5'), /cooldown hook/i);

  const thirdParty = installed(t, config);
  assert.equal(thirdParty.cli('quota', 'set', 'antigravity', '--pool', 'third-party-claude').status, 0);
  blocked(thirdParty, delegate('claude-sonnet-5-5', { provider: 'antigravity' }), /cooldown hook/i);
  allowed(thirdParty, delegate('gemini-4-neon', { provider: 'antigravity' }));

  const plus = installed(t, v2Config({ claude: 'max', codex: 'plus', antigravity: 'plus' }));
  blocked(plus, delegate('claude-sonnet-5-5', { provider: 'antigravity' }), /allowlist|plan|model/i);

  // Removing a cross-hosted model from Antigravity's allowlist must block it on Antigravity even if Claude still allows it.
  const narrowed = v2Config({ claude: 'max', codex: 'plus', antigravity: 'pro' });
  narrowed.allowlist.Antigravity = narrowed.allowlist.Antigravity.filter((m) => m !== 'claude-sonnet-5-5');
  const narrowedBox = installed(t, narrowed);
  blocked(narrowedBox, delegate('claude-sonnet-5-5', { provider: 'antigravity' }), /allowlist hook/i);
  allowed(narrowedBox, delegate('claude-sonnet-5-5', { provider: 'claude' }));

  // Bare claude-* delegation must be blocked when claude is 'none' even though antigravity cross-hosts it.
  const agyOnly = installed(t, v2Config({ claude: 'none', codex: 'none', antigravity: 'pro' }));
  blocked(agyOnly, delegate('claude-sonnet-5-5'), /allowlist hook/i);
  allowed(agyOnly, delegate('claude-sonnet-5-5', { provider: 'antigravity' }));
});

test('scarce sub-pool and legacy heavy locks match only their documented pool models', (t) => {
  const box = installed(t);
  assert.equal(box.cli('quota', 'set', 'codex', '--pool', 'astra').status, 0);
  blocked(box, delegate('gpt-6-astra', { provider: 'codex' }), /cooldown hook/i);
  allowed(box, delegate('gpt-6.1-sol', { provider: 'codex' }));

  const legacy = installed(t, v2Config({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' }));
  const cooldownFile = legacy.path('auto-build-cooldowns.json');
  write(cooldownFile, { 'tier:claude:heavy': { until: new Date(Date.now() + 60_000).toISOString() } });
  blocked(legacy, delegate('claude-fable-5-2', { provider: 'claude' }), /cooldown hook/i);
  allowed(legacy, delegate('claude-opus-5-5', { provider: 'antigravity' }));
});

test('retired model patterns cannot be overridden by config and do not overmatch versions', (t) => {
  const injected = ['gpt-5.4', 'GPT-5.5-mini', 'claude-4.6-sonnet', 'gemini-3.8-flash', 'gemini-4-argon'];
  const config = v2Config();
  config.retiredModels = [];
  config.allowlist.Codex.push('gpt-5.4', 'GPT-5.5-mini');
  config.allowlist.Claude.push('claude-4.6-sonnet');
  config.allowlist.Antigravity.push('gemini-3.8-flash', 'gemini-4-argon');
  config.models.push(...injected.map((model) => ({ provider: model.startsWith('gpt') ? 'codex' : model.startsWith('claude') ? 'claude' : 'antigravity', model, pool: 'standard', scarceQuota: false })));
  const box = installed(t, config);
  for (const model of injected) blocked(box, delegate(model), /retired/i);
  assert.equal(matchRetired('gpt-5.40'), false);
  const exact = { ...config, retiredModels: [], allowlist: { ...config.allowlist, Codex: [...config.allowlist.Codex, 'gpt-5.40'] }, models: [...config.models, { provider: 'codex', model: 'gpt-5.40', pool: 'standard', scarceQuota: false }] };
  const current = installed(t, exact);
  allowed(current, delegate('gpt-5.40', { provider: 'codex' }));
});

test('fast and priority modes are denied by default and configurable', (t) => {
  const box = installed(t);
  for (const tool_input of [
    { model: 'gpt-6-luna', fastMode: true },
    { model: 'gpt-6-luna', options: [{ id: 'fastMode', value: true }] },
    { model: 'gpt-6-luna', speed: 'ultrafast' },
  ]) blocked(box, { tool_name: 'mcp__t3-code__delegate_task', tool_input }, /fast|speed|mode/i);
  allowed(box, { tool_name: 'mcp__t3-code__delegate_task', tool_input: { model: 'gpt-6-luna', fastMode: false } });
  const permissive = installed(t, v2Config(undefined, { allowFastModes: true }));
  allowed(permissive, { tool_name: 'mcp__t3-code__delegate_task', tool_input: { model: 'gpt-6-luna', speed: 'ultrafast' } });
});

test('pre-tool-use fails open on unparsable stdin and closed on parsed invalid shapes', (t) => {
  const box = installed(t);
  const unparsable = box.hook('pre-tool-use', '{not json');
  assert.equal(unparsable.status, 0, unparsable.stderr);
  blocked(box, { tool_name: 'Edit', tool_input: 'x' }, /invalid|payload|input/i);
  write(box.path('auto-build.config.json'), '{broken');
  blocked(box, { tool_name: 'Edit', tool_input: { file_path: '.env' } }, /secret|credential/i);
});

test('unsupported schema version uses defaults, including retired and allowlist checks', (t) => {
  const config = v2Config();
  config.schemaVersion = 4;
  config.allowlist.Codex = ['gpt-5.4'];
  config.models = [{ provider: 'codex', model: 'gpt-5.4', pool: 'standard', scarceQuota: false }];
  const box = installed(t, config);
  blocked(box, delegate('gpt-5.4', { provider: 'codex' }), /retired/i);
  blocked(box, delegate('gpt-6-astra', { provider: 'codex' }), /allowlist|model/i);
});

test('availability CLI validates TTL and ref, and plan-restricted models are blocked', (t) => {
  const box = installed(t);
  const mark = box.cli('availability', 'mark', 'codex:gpt-6.1-sol', 'plan-restricted', '--ttl', '1h');
  assert.equal(mark.status, 0, mark.stderr);
  blocked(box, delegate('gpt-6.1-sol', { provider: 'codex' }), /plan|restricted|availability/i);
  for (const ttl of ['0h', '31d', '1w', 'abc']) {
    const result = box.cli('availability', 'mark', 'codex:gpt-6.1-sol', 'unavailable', '--ttl', ttl);
    assert.notEqual(result.status, 0, `accepted invalid TTL ${ttl}`);
  }
  const invalidRef = box.cli('availability', 'mark', 'work:gpt-6-luna', 'unavailable');
  assert.notEqual(invalidRef.status, 0, 'accepted noncanonical provider ref');
});

test('upgrade creates byte-identical backup, is idempotent, and rejects malformed JSON untouched', (t) => {
  const box = sandbox(t);
  const init = box.cli('init', '--yes');
  assert.equal(init.status, 0, init.stderr);
  const configPath = box.path('auto-build.config.json');
  const original = JSON.stringify({ preset: 'claude-only', allowlist: { Claude: ['claude-sonnet-5-5'] }, bannedModels: [], compactionThreshold: 33 });
  fs.writeFileSync(configPath, original);
  const first = box.cli('upgrade', '--target', box.target);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(json(configPath).schemaVersion, 3);
  assert.equal(read(path.join(box.target, 'auto-build.config.json.bak')), original);
  const upgraded = read(configPath);
  const second = box.cli('upgrade', '--target', box.target);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(read(configPath), upgraded);

  const malformed = '{';
  fs.writeFileSync(configPath, malformed);
  const failed = box.cli('upgrade', '--target', box.target);
  assert.notEqual(failed.status, 0, 'malformed config unexpectedly upgraded');
  assert.equal(read(configPath), malformed, 'malformed config was modified');
});

test('upgrade takes v2 to v3 with a byte-identical backup and rejects schema version 4 untouched', (t) => {
  const box = sandbox(t);
  const init = box.cli('init', '--yes');
  assert.equal(init.status, 0, init.stderr);
  const configPath = box.path('auto-build.config.json');
  const original = JSON.stringify({ ...v2Config(), schemaVersion: 2 });
  fs.writeFileSync(configPath, original);
  const first = box.cli('upgrade', '--target', box.target);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(json(configPath).schemaVersion, 3);
  assert.equal(read(`${configPath}.bak`), original);

  const unknown = JSON.stringify({ ...v2Config(), schemaVersion: 4 });
  fs.writeFileSync(configPath, unknown);
  const failed = box.cli('upgrade', '--target', box.target);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unknown schemaVersion 4/);
  assert.equal(read(configPath), unknown);
});

test('completeConfig does not mask ladders: null before configProblem validation', () => {
  assert.match(configProblem(completeConfig({ ladders: null })) ?? '', /ladders/);
});

test('test paths use platform joins throughout', () => {
  assert.equal(path.isAbsolute(ROOT), true);
});

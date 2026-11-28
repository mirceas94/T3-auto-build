import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, findCli, parseTiers } from '../lib/detect.mjs';
import { discover } from '../lib/discover.mjs';

test('detect selects presets from available provider binaries only', () => {
  const binaries = { claude: null, codex: null, antigravity: null };
  const detected = (present) => detect({
    home: 'sandbox-home',
    which: (name) => binaries[name],
    exists: () => true,
  });
  assert.equal(detected().preset, 'claude-only');
  binaries.claude = 'claude';
  binaries.codex = 'codex';
  assert.equal(detected().preset, 'claude-codex');
  binaries.antigravity = 'agy';
  assert.equal(detected().preset, 'tri-provider');
  binaries.claude = null;
  assert.equal(detected().preset, 'claude-only');
});

test('detect checks only the expected home marker paths and reports provider binaries', () => {
  const seen = [];
  const result = detect({
    home: 'H',
    which: (name) => ({ claude: '/bin/c', codex: null, antigravity: '/bin/a' })[name],
    exists: (file) => { seen.push(file); return file.replace(/\\/g, '/').endsWith('H/.gemini/antigravity'); },
  });
  assert.deepEqual(result.providers, {
    claude: { binary: '/bin/c', marker: false },
    codex: { binary: null, marker: false },
    antigravity: { binary: '/bin/a', marker: true },
  });
  assert.deepEqual(seen.map((file) => file.replace(/\\/g, '/')), ['H/.claude', 'H/.codex', 'H/.antigravity', 'H/.gemini/antigravity']);
  assert.equal(result.preset, 'claude-only');
});

test('the Antigravity CLI is found and versioned as agy, with antigravity as fallback', async () => {
  const only = (...names) => (name) => (names.includes(name) ? `/bin/${name}` : null);
  assert.deepEqual(findCli('antigravity', only('agy', 'antigravity')), { name: 'agy', path: '/bin/agy' });
  assert.deepEqual(findCli('antigravity', only('antigravity')), { name: 'antigravity', path: '/bin/antigravity' });
  assert.equal(findCli('antigravity', only()), null);
  assert.equal(findCli('claude', only('agy')), null);
  const calls = [];
  const { binaries } = await discover({
    config: {}, which: only('agy'),
    runner: async (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '1.2.3' }; },
  });
  assert.deepEqual(calls, [['agy', '--version']]);
  assert.deepEqual(binaries.antigravity, { found: true, version: '1.2.3' });
});

test('tiers derive sharing mode and heavy model defaults', () => {
  const tiers = parseTiers('claude:max,codex:pro:monday,antigravity:ultra');
  assert.equal(tiers.claude.sharing, 'heavy-tier-only');
  assert.equal(tiers.codex.sharing, 'heavy-tier-only');
  assert.equal(tiers.antigravity.sharing, 'heavy-tier-only');
  assert.equal(tiers.codex.resetDay, 'monday');
  assert.deepEqual(tiers.claude.heavyModels, ['claude-fable-5-2']);
  assert.deepEqual(tiers.codex.heavyModels, ['gpt-6-astra', 'gpt-6.2-astra']);
  assert.deepEqual(tiers.antigravity.heavyModels, []);
});

test('provider tiers that share limits lock at provider scope', () => {
  const tiers = parseTiers('claude:pro,codex:plus,antigravity:standard');
  assert.deepEqual(Object.fromEntries(Object.entries(tiers).map(([key, value]) => [key, value.sharing])), {
    claude: 'provider', codex: 'provider', antigravity: 'provider',
  });
});

test('tier parsing rejects duplicate providers, unknown plans, and invalid weekdays', () => {
  for (const input of ['claude:pro,claude:max', 'claude:ultra', 'codex:pro:funday', 'claude:max:monday:extra']) {
    assert.throws(() => parseTiers(input));
  }
});

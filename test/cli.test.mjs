import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox, write, json } from './helpers.mjs';

test('help documents every command and W2b flag', (t) => {
  const s = sandbox(t);
  const result = s.cli('--help');
  assert.equal(result.status, 0);
  for (const text of ['init', 'upgrade', 'check-models', 'sync-models', 'availability mark', 'availability status', 'quota set', 'quota status', 'quota clear', 'quota check', 'doctor', 'uninstall', '--target', '--yes', '--claude-tier', '--codex-tier', '--antigravity-tier', '--parent', '--allow-usage-credits', '--allow-fast-modes', '--verified-org', '--skill-targets', '--probe', '--refresh', '--probe-scarce', '--json', '--auto', '--apply', '--dry-run', '--providers', '--force', '--ttl', '--reason', '--pool', '--burst', '--5h', '--weekly', '--until', '--all', 'cross-hosted']) {
    assert.ok(result.stdout.includes(text), `help missing ${text}`);
  }
});

test('unknown tier exits 2 and lists valid tier ids', (t) => {
  const s = sandbox(t);
  const result = s.cli('init', '--yes', '--claude-tier', 'made-up');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /valid tiers:.*none.*pro.*max/s);
});

test('availability mark writes canonical entry and rejects malformed refs and TTLs', (t) => {
  const s = sandbox(t);
  let result = s.cli('availability', 'mark', 'antigravity:claude-opus-5-5', 'plan-restricted', '--ttl', '24h', '--reason', 'plan limit');
  assert.equal(result.status, 0, result.stderr);
  const availability = json(s.path('auto-build-availability.json'));
  assert.equal(availability.models['antigravity:claude-opus-5-5'].status, 'plan-restricted');
  assert.equal(availability.models['antigravity:claude-opus-5-5'].source, 'mark');
  for (const args of [
    ['work:gpt-6-luna', 'available'],
    ['codex:gpt-6-luna', 'available', '--ttl', '31d'],
    ['codex:gpt-6-luna', 'available', '--ttl', '2x'],
  ]) {
    result = s.cli('availability', 'mark', ...args);
    assert.equal(result.status, 2, args.join(' '));
  }
});

test('check-models honors a fresh cache and reports no probe work', (t) => {
  const s = sandbox(t);
  s.cli('init', '--yes');
  write(s.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: new Date().toISOString(), ttlMs: 43_200_000,
    binaries: {}, models: {}, discoveredNew: [], missingConfigured: [],
  });
  const result = s.cli('check-models', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stale, false);
  assert.deepEqual(report.probed, []);
});

test('sync-models --apply promotes known drift, backs up config, re-renders, and leaves unknowns disabled', (t) => {
  const s = sandbox(t);
  let result = s.cli('init', '--yes', '--codex-tier', 'pro-100');
  assert.equal(result.status, 0, result.stderr);
  const configPath = s.path('auto-build.config.json');
  const config = json(configPath);
  assert.ok(config.allowlist.Codex.includes('gpt-6.1-sol'));
  write(s.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: new Date().toISOString(), ttlMs: 43_200_000, binaries: {}, models: {},
    discoveredNew: [
      { provider: 'codex', model: 'gpt-6.2-sol', family: 'gpt-sol', version: '6.2', supersedes: 'gpt-6.1-sol' },
      { provider: 'codex', model: 'gpt-7-mystery', family: null, version: null },
    ], missingConfigured: [],
  });
  const oldText = fs.readFileSync(configPath, 'utf8');
  result = s.cli('sync-models', '--apply');
  assert.equal(result.status, 0, result.stderr);
  const updated = json(configPath);
  assert.ok(updated.allowlist.Codex.includes('gpt-6.2-sol'));
  assert.ok(!updated.allowlist.Codex.includes('gpt-6.1-sol'));
  assert.ok(!updated.allowlist.Codex.includes('gpt-7-mystery'));
  assert.equal(fs.readFileSync(`${configPath}.bak`, 'utf8'), oldText);
  assert.match(fs.readFileSync(s.path('skills', 'auto-build', 'SKILL.md'), 'utf8'), /gpt-6\.2-sol/);
  assert.match(result.stdout, /promoted codex:gpt-6\.1-sol -> codex:gpt-6\.2-sol/);
  assert.match(result.stdout, /unknown family codex:gpt-7-mystery/);
});

test('sync-models --apply --dry-run does not modify config or SKILL.md, and availability status guards invalid checkedAt', (t) => {
  const s = sandbox(t);
  assert.equal(s.cli('init', '--yes', '--codex-tier', 'pro-100').status, 0);
  const configPath = s.path('auto-build.config.json');
  const skillPath = s.path('skills', 'auto-build', 'SKILL.md');
  const beforeConfig = fs.readFileSync(configPath, 'utf8');
  const beforeSkill = fs.readFileSync(skillPath, 'utf8');
  write(s.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: 'not-a-date', ttlMs: 0, binaries: {}, models: {},
    discoveredNew: [{ provider: 'codex', model: 'gpt-6.2-sol', family: 'gpt-sol', version: '6.2', supersedes: 'gpt-6.1-sol' }],
    missingConfigured: [],
  });
  const dry = s.cli('sync-models', '--apply', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /nothing was written/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), beforeSkill);

  const status = s.cli('availability', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /availability cache stale/);
  assert.doesNotMatch(status.stdout, /NaNh/);
});

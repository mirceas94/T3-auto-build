import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { LEDGER_FILE, RETIRED_MODELS, which } from '../hooks/_shared.mjs';
import { loadCatalogOverrides, validateCatalogOverrides } from '../hooks/_catalog.mjs';
import { doctor } from '../lib/doctor.mjs';
import { CliError } from '../lib/paths.mjs';
import { upgrade } from '../lib/install.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { getReference, REF_TOPICS } from '../lib/ref.mjs';
import { recordTrace, summarizeStats } from '../lib/telemetry.mjs';
import { json, read, sandbox, tree, write } from './helpers.mjs';

const CONFIG = 'auto-build.config.json';
const QUIET = { log: () => {} };
const v3 = () => toConfig(resolveTiers({ claude: 'max', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });
const init = (box, ...args) => {
  const result = box.cli('init', '--yes', '--skill-targets', 'none', ...args);
  assert.equal(result.status, 0, result.stderr);
};

test('catalog rejects malformed override edges and cannot re-enable retired built-ins', (t) => {
  const box = sandbox(t);
  const invalid = [
    { models: [{ provider: 'other', model: 'custom-model' }] },
    { retiredModels: [], models: [{ provider: 'codex', model: 'gpt-5.5' }] },
    { aliases: { A: 'B', B: 'A' } },
    { aliases: { A: 'B', B: 'C', C: 'A' } },
    { aliases: { 'claude-sonnet-5-5': 'gpt-6-luna' } },
    { models: [{ provider: 'codex', model: 'claude-sonnet-5-5' }] },
    { models: [{ provider: 'codex', model: '' }] },
    { models: [{ provider: 'codex', model: 'custom\u0000model' }] },
    { aliases: { Safe: 'bad\u001bname' } },
  ];
  const accepted = invalid.filter((raw) => validateCatalogOverrides(raw).valid);
  assert.deepEqual(accepted, [], `accepted malformed overrides: ${JSON.stringify(accepted)}`);
});

test('catalog loads BOM and CRLF JSON and still rejects cyclic files', (t) => {
  const box = sandbox(t);
  const file = box.path('catalog.overrides.json');
  fs.mkdirSync(box.target, { recursive: true });
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ retiredModels: ['old-model'] })}\r\n`);
  assert.deepEqual(loadCatalogOverrides(box.target), {
    valid: true, overrides: { retiredModels: ['old-model'] }, errors: [],
  });
  fs.writeFileSync(file, '{"aliases":{"A":"B","B":"A"}}\r\n');
  assert.equal(loadCatalogOverrides(box.target).valid, false);
  assert.ok(RETIRED_MODELS.length > 0);
});

test('preflight preserves its snapshot contract, exhausted and filtered ladders, and safe resume state', async (t) => {
  const box = sandbox(t);
  const now = Date.parse('2026-05-01T00:00:00Z');
  const config = v3();
  config.preflight = { ttl: 60_000 };
  config.ladders.tier1 = ['gpt-6-luna'];
  write(box.path(CONFIG), config);
  write(box.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: new Date(now).toISOString(), ttlMs: 3_600_000, models: {},
  });
  write(box.path('auto-build-cooldowns.json'), {
    'provider:codex': { scope: 'provider', window: '5h', until: new Date(now + 120_000).toISOString(), reason: 'busy' },
  });
  const cwd = path.join(box.dir, 'not a repository');
  fs.mkdirSync(cwd);
  const stateFile = path.join(cwd, '.claude', 'auto-build-state.json');
  write(stateFile, '[]');

  const result = await runPreflight({ configDir: box.target, cwd, now });
  assert.equal(result.version, 1);
  assert.equal(result.generatedAt, new Date(now).toISOString());
  assert.equal(result.expiresAt, new Date(now + 60_000).toISOString());
  assert.equal(result.configHash, createHash('sha256').update(read(box.path(CONFIG))).digest('hex'));
  assert.deepEqual(result.ladders.tier1, []);
  assert.deepEqual(result.baseline, []);
  assert.equal(result.resume.valid, false);
  assert.match(result.resume.error, /not a JSON object/);
  assert.deepEqual(result.locks.map(({ key }) => key), ['provider:codex']);
  assert.ok(Object.values(result.ladders).flat().every((ref) => !/^gpt-/i.test(ref.split('@')[0])));

  write(box.path('auto-build-cooldowns.json'), {});
  for (const [provider, prefix] of [['claude', /^(claude:)?claude-/], ['codex', /^(codex:)?gpt-/], ['antigravity', /^(antigravity:|gemini-)/]]) {
    const restricted = await runPreflight({ configDir: box.target, cwd, flags: `--${provider}-only`, now });
    const refs = Object.values(restricted.ladders).flat();
    assert.ok(refs.length > 0, provider);
    for (const ref of refs) assert.match(ref.split('@')[0], prefix, `${provider}: ${ref}`);
  }
  write(stateFile, '{ broken');
  assert.equal((await runPreflight({ configDir: box.target, cwd, now })).resume.valid, false);
  write(stateFile, { flags: 'not-an-array' });
  assert.equal((await runPreflight({ configDir: box.target, cwd, now })).resume.valid, false);
});

test('sandbox prevents preflight and quota check from spawning provider CLIs on PATH', async (t) => {
  const trapDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3ab-trap-')));
  const marker = path.join(trapDir, 'spawned.txt');
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(trapDir, { recursive: true, force: true, maxRetries: 5 });
  });
  for (const name of ['codex', 'agy', 'antigravity', 'claude']) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(trapDir, `${name}.cmd`), `@echo ${name}>>"${marker}"\r\n@exit /b 0\r\n`);
    } else {
      const bin = path.join(trapDir, name);
      fs.writeFileSync(bin, `#!/bin/sh\necho "${name}" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    }
  }
  process.env.PATH = `${trapDir}${path.delimiter}${savedPath ?? ''}`;

  const box = sandbox(t);
  const now = Date.now();
  write(box.path(CONFIG), v3());
  write(box.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: new Date(now).toISOString(), ttlMs: 3_600_000, models: {},
  });

  const inProc = await runPreflight({ configDir: box.target, cwd: box.dir, now });
  assert.deepEqual(inProc.quota.windows, []);

  const cliPreflight = box.cli('preflight', '--json');
  assert.equal(cliPreflight.status, 0, cliPreflight.stderr);
  assert.deepEqual(JSON.parse(cliPreflight.stdout).quota.windows, []);

  const cliCheck = box.cli('quota', 'check', '--refresh', '--claude-usage');
  assert.equal(cliCheck.status, 0, cliCheck.stderr);

  assert.equal(fs.existsSync(marker), false, 'sandbox must not spawn provider CLIs');
});

test('telemetry sanitizes hostile text, rotates, and skips corrupt JSONL lines', (t) => {
  const box = sandbox(t);
  const first = recordTrace(box.target, { step: `x\u0000\u001b${'z'.repeat(200)}`, outcome: `ok\n${'q'.repeat(140)}` }, { maxBytes: 250 });
  assert.ok(first.step.length <= 120);
  assert.doesNotMatch(first.step, /[\u0000-\u001f\u007f]/);
  recordTrace(box.target, { step: 'second' }, { maxBytes: 250 });
  recordTrace(box.target, { step: 'third' }, { maxBytes: 250 });
  assert.ok(fs.existsSync(`${box.path(LEDGER_FILE)}.1`));
  fs.appendFileSync(box.path(LEDGER_FILE), '\n{broken\n[1]\n');
  assert.equal(summarizeStats(box.target).totalSteps, 2);

});

test('telemetry refuses a symlinked ledger without writing through it', (t) => {
  const box = sandbox(t);
  const outside = path.join(box.dir, 'outside.jsonl');
  write(outside, 'untouched');
  const ledger = box.path(LEDGER_FILE);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  try {
    fs.symlinkSync(outside, ledger, 'file');
  } catch (error) {
    t.skip(`file symlinks unavailable: ${error.code ?? error.message}`);
    return;
  }
  assert.throws(() => recordTrace(box.target, { step: 'must not follow' }), /symlink/);
  assert.equal(read(outside), 'untouched');
});

test('disabled telemetry does not create a ledger; refs accept only declared topics safely', (t) => {
  const box = sandbox(t);
  init(box, '--claude-tier', 'pro', '--codex-tier', 'plus');
  const config = json(box.path(CONFIG));
  write(box.path(CONFIG), { ...config, telemetry: { enabled: false } });
  const disabled = box.cli('trace', 'record', '--step', 'secret');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /disabled/);
  assert.equal(fs.existsSync(box.path(LEDGER_FILE)), false);
  for (const topic of REF_TOPICS) assert.equal(typeof getReference(topic, { configDir: box.target }), 'string');
  for (const topic of ['..\\settings.json', '../settings.json', '__proto__']) {
    assert.throws(() => getReference(topic, { configDir: box.target }), (error) => error instanceof CliError && error.exitCode === 2);
  }
  assert.doesNotThrow(() => getReference('flags', { configDir: box.path('missing-config') }));
});

test('upgrade supports v1 and v2, is idempotent on v3, and refuses unknown schemas or edited hooks atomically', (t) => {
  const one = sandbox(t);
  init(one);
  assert.equal(json(one.path(CONFIG)).schemaVersion, undefined);
  assert.equal(upgrade(one.target, QUIET).config.schemaVersion, 3);
  const upgradedOne = tree(one.target);
  assert.equal(upgrade(one.target, QUIET).upgraded, false);
  assert.deepEqual(tree(one.target), upgradedOne);

  const two = sandbox(t);
  init(two, '--claude-tier', 'pro', '--codex-tier', 'plus');
  const current = json(two.path(CONFIG));
  const { telemetry, preflight, ...v2config } = current;
  write(two.path(CONFIG), { ...v2config, schemaVersion: 2 });
  assert.equal(upgrade(two.target, QUIET).config.schemaVersion, 3);

  const four = sandbox(t);
  init(four);
  write(four.path(CONFIG), { ...json(four.path(CONFIG)), schemaVersion: 4 });
  const fourBefore = tree(four.target);
  assert.throws(() => upgrade(four.target, QUIET), /unknown schemaVersion 4/);
  assert.deepEqual(tree(four.target), fourBefore);

  const edited = sandbox(t);
  init(edited);
  const hook = edited.path('hooks', 't3-auto-build', 'pre-tool-use.mjs');
  write(hook, '// user edit');
  const before = tree(edited.target);
  assert.throws(() => upgrade(edited.target, QUIET), /local changes/);
  assert.deepEqual(tree(edited.target), before);
});

test('doctor fix is a dry run without yes and repairs hook, mirror and exclude idempotently', (t) => {
  const box = sandbox(t);
  Object.assign(box.env, { XDG_CONFIG_HOME: path.join(box.home, 'xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: box.dir });
  delete box.env.GIT_CONFIG_GLOBAL;
  const installed = box.cli('init', '--yes', '--skill-targets', 'none');
  assert.equal(installed.status, 0, installed.stderr);
  const mirrorRoot = path.join(box.dir, 'provider skills');
  const mirror = path.join(mirrorRoot, 'auto-build', 'SKILL.md');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  const manifestPath = box.path('t3-auto-build.manifest.json');
  const manifest = json(manifestPath);
  write(manifestPath, { ...manifest, skillTargets: [mirrorRoot], skillMirrors: { [mirror]: 'stale' } });
  write(mirror, 'edited mirror');
  const hook = box.path('hooks', 't3-auto-build', 'pre-tool-use.mjs');
  write(hook, 'edited hook');
  const cwd = path.join(box.dir, 'project');
  fs.mkdirSync(cwd);
  const git = which('git');
  if (git) assert.equal(spawnSync(git, ['-C', cwd, 'init', '-q'], { env: box.env }).status, 0);
  const before = tree(box.dir);
  const dryMessages = [];
  doctor(box.target, { fix: true, yes: false, cwd, log: (line) => dryMessages.push(line) });
  assert.deepEqual(tree(box.dir), before);
  assert.match(dryMessages.join('\n'), /would fix:/);

  const fixed = [];
  doctor(box.target, { fix: true, yes: true, cwd, log: (line) => fixed.push(line) });
  assert.notEqual(read(hook), 'edited hook');
  if (fs.existsSync(mirror)) assert.notEqual(read(mirror), 'edited mirror');
  if (git) assert.equal(spawnSync(git, ['-C', cwd, 'check-ignore', '--quiet', '--no-index', '.claude/auto-build-state.json'], { env: box.env }).status, 0);
  const after = tree(box.dir);
  const second = [];
  doctor(box.target, { fix: true, yes: true, cwd, log: (line) => second.push(line) });
  assert.deepEqual(tree(box.dir), after);
  assert.match(second.join('\n'), /nothing to fix/);
});

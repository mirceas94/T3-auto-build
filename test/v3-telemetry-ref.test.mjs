import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { LEDGER_FILE } from '../hooks/_shared.mjs';
import { CliError } from '../lib/paths.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { REF_TOPICS, getReference } from '../lib/ref.mjs';
import { formatStats, recordTrace, summarizeStats } from '../lib/telemetry.mjs';
import { read, sandbox, write } from './helpers.mjs';

const DAY = 86_400_000;
const lines = (file) => read(file).trimEnd().split('\n').map(JSON.parse);
const usage = (pattern) => (error) => error instanceof CliError && error.exitCode === 2 && pattern.test(error.message);

test('recordTrace appends one sanitized line of known fields', (t) => {
  const box = sandbox(t);
  const record = recordTrace(box.target, {
    ts: '2026-01-02T03:04:05Z', level: 'l2', shape: 'a', effort: 'HIGH', step: 'build\n\u001bwave', provider: 'claudeAgent',
    model: 'claude-opus-5-5', outcome: 'ok', durationMs: 5, prompt: 'secret',
  });
  assert.deepEqual(record, {
    ts: '2026-01-02T03:04:05.000Z', level: 'L2', shape: 'A', effort: 'high', step: 'build wave', provider: 'claude',
    model: 'claude-opus-5-5', outcome: 'ok', durationMs: 5,
  });
  recordTrace(box.target, { step: 'x'.repeat(500) });
  const stored = lines(box.path(LEDGER_FILE));
  assert.deepEqual(stored[0], record);
  assert.equal(stored[1].step.length, 120);
});

test('recordTrace refuses unusable entries and writes nothing', (t) => {
  const box = sandbox(t);
  for (const [entry, reason] of [
    [null, /JSON object/], [[], /JSON object/], [{}, /needs a step/], [{ step: 'a', level: 'L9' }, /invalid level/],
    [{ step: 'a', shape: 'C' }, /invalid shape/], [{ step: 'a', effort: 'max' }, /invalid effort/],
    [{ step: 'a', ts: 'soon' }, /invalid ts/], [{ step: 1 }, /invalid step/],
    [{ step: 'a', durationMs: -1 }, /invalid duration/], [{ step: 'a', durationMs: 1.5 }, /invalid duration/],
  ]) assert.throws(() => recordTrace(box.target, entry), usage(reason), JSON.stringify(entry));
  assert.ok(!fs.existsSync(box.path(LEDGER_FILE)));
});

test('the ledger rotates to .1 before it outgrows maxBytes', (t) => {
  const box = sandbox(t);
  const file = box.path(LEDGER_FILE);
  const entry = (step) => ({ ts: '2026-01-02T00:00:00Z', step });
  recordTrace(box.target, entry('one'));
  const size = fs.statSync(file).size;
  // Exactly at the limit stays in one file.
  recordTrace(box.target, entry('two'), { maxBytes: size * 2 });
  assert.equal(lines(file).length, 2);
  assert.ok(!fs.existsSync(`${file}.1`));
  recordTrace(box.target, entry('thr'), { maxBytes: size * 2 });
  assert.deepEqual(lines(`${file}.1`).map((line) => line.step), ['one', 'two']);
  assert.deepEqual(lines(file).map((line) => line.step), ['thr']);
  // The next rotation replaces the older file.
  recordTrace(box.target, entry('for'), { maxBytes: 1 });
  assert.deepEqual(lines(`${file}.1`).map((line) => line.step), ['thr']);
});

test('summarizeStats skips malformed and old lines and counts the rest', (t) => {
  const box = sandbox(t);
  const now = Date.parse('2026-02-01T00:00:00Z');
  const ago = (days) => new Date(now - days * DAY).toISOString();
  const entries = [
    { ts: ago(1), step: 'run' },
    { ts: ago(1), step: 'build', provider: 'codex', model: 'gpt-6-luna', durationMs: 1000 },
    { ts: ago(2), step: 'audit', provider: 'claude', model: 'claude-opus-5-5', outcome: 'REJECTED', durationMs: 3000 },
    { ts: ago(2), step: 'build', provider: 'codex', model: 'gpt-6-luna', failoverFrom: 'claude', durationMs: -5 },
    { ts: ago(40), step: 'old', provider: 'codex' },
    { step: 'no time' },
  ];
  write(box.path(LEDGER_FILE), `﻿${entries.map(JSON.stringify).join('\r\n')}\n\n{ partial\n[1]\nnull\n"text"\n{"ts":"`);
  const stats = summarizeStats(box.target, { now });
  assert.deepEqual(stats, {
    totalRuns: 1,
    totalSteps: 3,
    byProvider: { codex: 2, claude: 1 },
    byModel: { 'gpt-6-luna': 2, 'claude-opus-5-5': 1 },
    failovers: 1,
    auditRejections: 1,
    avgDurationMs: 2000,
    windowDays: 30,
  });
  assert.equal(summarizeStats(box.target, { days: 60, now }).totalSteps, 4);
  assert.equal(formatStats(stats), [
    'last 30d: 1 runs, 3 steps, avg 2.0s/step',
    'failovers 1; audit rejections 1',
    'providers: codex 2, claude 1',
    'models: gpt-6-luna 2, claude-opus-5-5 1',
  ].join('\n'));
});

test('stats of a missing ledger are empty; an unreadable one is an error', (t) => {
  const box = sandbox(t);
  const stats = summarizeStats(box.target);
  assert.equal(stats.totalSteps + stats.totalRuns + stats.avgDurationMs, 0);
  assert.match(formatStats(stats), /providers: none\nmodels: none$/);
  fs.mkdirSync(box.path(LEDGER_FILE), { recursive: true });
  assert.throws(() => summarizeStats(box.target), /cannot be read/);
});

const config = () => toConfig(resolveTiers({ claude: 'max', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });

test('getReference renders every topic with this installation\'s paths and models', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), config());
  const configDir = box.target;
  const base = configDir.replace(/\\/g, '/');
  const text = Object.fromEntries(REF_TOPICS.map((topic) => [topic, getReference(topic, { configDir })]));
  assert.match(text.flags, /^## Inline flags/);
  for (const flag of ['--fast', '--resume', '--commit', '--codex-only']) assert.ok(text.flags.includes(flag), flag);
  assert.match(text.cooldowns, /^## Cooldowns/);
  assert.ok(text.cooldowns.includes(`${base}/auto-build-cooldowns.json`));
  assert.match(text.cooldowns, /codex:gpt-6-astra \[astra\]/);
  assert.match(text.cooldowns, /recheck-via-t3 canary/);
  assert.match(text.state, /^## Run state/);
  assert.ok(text.state.includes(`${base}/${LEDGER_FILE}`));
  assert.ok(text.all.includes(`Config: \`${base}/auto-build.config.json\``));
  for (const topic of ['flags', 'cooldowns', 'state']) assert.ok(text.all.includes(text[topic]), topic);
});

test('an unknown ref topic is a usage error', (t) => {
  const box = sandbox(t);
  for (const topic of ['nope', undefined, 'FLAGS', '__proto__']) {
    assert.throws(() => getReference(topic, { configDir: box.target }), usage(/unknown ref topic.*flags, cooldowns, state, all/));
  }
});

test('CLI trace record, stats and ref', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), config());
  const ok = (...args) => {
    const result = box.cli(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  assert.equal(ok('trace', 'record', '--step', 'run'), 'recorded\n');
  ok('trace', 'record', '--step', 'build', '--model', 'gpt-6-luna', '--provider', 'codex', '--duration', '1500');
  ok('trace', 'record', '{"step":"audit","outcome":"rejected"}');
  const stats = JSON.parse(ok('stats', '--json'));
  assert.deepEqual([stats.totalRuns, stats.totalSteps, stats.auditRejections, stats.avgDurationMs], [1, 2, 1, 1500]);
  assert.match(ok('stats', '--days', '7'), /^last 7d: 1 runs, 2 steps/);
  assert.match(ok('ref', 'flags'), /## Inline flags/);

  const before = read(box.path(LEDGER_FILE));
  for (const args of [
    ['trace', 'record'], ['trace', 'record', '{"step":"a"}', '--step', 'b'], ['trace', 'record', '{ nope'],
    ['trace', 'record', '--step', 'a', '--duration', 'long'], ['trace', 'nope'], ['stats', '--days', '0'],
    ['stats', '--days', 'x'], ['ref'], ['ref', 'nope'],
  ]) assert.equal(box.cli(...args).status, 2, args.join(' '));
  assert.equal(read(box.path(LEDGER_FILE)), before);

  write(box.path('auto-build.config.json'), { ...config(), telemetry: { enabled: false } });
  assert.match(ok('trace', 'record', '--step', 'a'), /telemetry is disabled/);
  assert.equal(read(box.path(LEDGER_FILE)), before);
  write(box.path('auto-build.config.json'), { ...config(), telemetry: { maxBytes: 1 } });
  ok('trace', 'record', '--step', 'a');
  assert.equal(read(box.path(`${LEDGER_FILE}.1`)), before);
});

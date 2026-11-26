import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, write, json } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

test('doctor warns for legacy v1 config and stale availability cache with upgrade hint', (t) => {
  const s = sandbox(t);
  const installed = s.cli('init', '--yes');
  assert.equal(installed.status, 0, installed.stderr);
  const config = json(s.path('auto-build.config.json'));
  delete config.schemaVersion;
  delete config.subscriptions;
  delete config.models;
  delete config.parent;
  delete config.allowFastModes;
  delete config.allowUsageCredits;
  delete config.verifiedOrg;
  delete config.retiredModels;
  delete config.planRestrictedModels;
  delete config.userBannedModels;
  delete config.maxParallelBuilders;
  write(s.path('auto-build.config.json'), config);
  write(s.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(), ttlMs: 1,
    binaries: {}, models: {}, discoveredNew: [], missingConfigured: [],
  });
  const result = s.cli('doctor');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /legacy v1 config — run `t3-auto-build upgrade`/);
  assert.match(result.stdout, /auto-build-availability\.json is stale/);
});

test('doctor warns when a tier has no installed CLI binary', (t) => {
  const s = sandbox(t);
  const installed = s.cli('init', '--yes', '--claude-tier', 'pro');
  assert.equal(installed.status, 0, installed.stderr);
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--target', s.target], {
    cwd: s.dir, env: { ...s.env, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude tier pro is configured but its CLI binary is missing/);
  assert.doesNotMatch(result.stdout, /codex tier none/);
  assert.doesNotMatch(result.stdout, /antigravity tier none/);
});

test('doctor handles invalid checkedAt, non-object cooldown JSON, and non-file managed paths cleanly', (t) => {
  const s = sandbox(t);
  assert.equal(s.cli('init', '--yes', '--claude-tier', 'pro').status, 0);
  write(s.path('auto-build-availability.json'), {
    schemaVersion: 1, checkedAt: 'not-a-date', ttlMs: 3_600_000, models: {},
  });
  write(s.path('auto-build-cooldowns.json'), '[]');
  const clean = s.cli('doctor');
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /NaNh/);
  assert.match(clean.stdout, /auto-build-cooldowns\.json is not a JSON object/);

  // Replace a managed file with a directory: doctor should report fail, not crash with EISDIR.
  const claudeMd = s.path('CLAUDE.md');
  fs.rmSync(claudeMd);
  fs.mkdirSync(claudeMd);
  const broken = s.cli('doctor');
  assert.equal(broken.status, 1);
  assert.doesNotMatch(broken.stderr, /unexpected error/);
  assert.match(broken.stdout, /fail.*not a regular file: CLAUDE\.md/);
});

test('doctor flags symlinked availability and cooldown state files instead of following them', (t) => {
  const s = sandbox(t);
  assert.equal(s.cli('init', '--yes', '--claude-tier', 'pro').status, 0);
  const outside = path.join(s.dir, 'outside');
  fs.mkdirSync(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, s.path('auto-build-availability.json'), linkType);
  fs.symlinkSync(outside, s.path('auto-build-cooldowns.json'), linkType);
  const res = s.cli('doctor');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /fail.*unsafe path or symlink: auto-build-availability\.json/);
  assert.match(res.stdout, /fail.*unsafe path or symlink: auto-build-cooldowns\.json/);
});

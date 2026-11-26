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
});

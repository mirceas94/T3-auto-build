import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { discoverSkillDirs, parseSkillTargets } from '../lib/mirrors.mjs';
import { json, read, sandbox, write } from './helpers.mjs';

test('discoverSkillDirs finds existing Codex, .agents, and Antigravity profile skill roots only', (t) => {
  const box = sandbox(t);
  assert.deepEqual(discoverSkillDirs({ home: box.home, target: box.target }), []);

  fs.mkdirSync(path.join(box.home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.gemini', 'config'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.t3', 'userdata', 'providers', 'antigravity', 'profile-a', 'config'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.t3', 'userdata', 'providers', 'antigravity', 'profile-empty'), { recursive: true });

  const found = discoverSkillDirs({ home: box.home, target: box.target });
  assert.deepEqual(found, [
    path.join(box.home, '.agents', 'skills'),
    path.join(box.home, '.codex', 'skills'),
    path.join(box.home, '.gemini', 'config', 'skills'),
    path.join(box.home, '.t3', 'userdata', 'providers', 'antigravity', 'profile-a', 'config', 'skills'),
  ].sort((a, b) => (a < b ? -1 : 1)));
});

test('init mirrors SKILL.md to discovered provider roots, sync-models updates them, and uninstall cleans them up', (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.t3', 'userdata', 'providers', 'antigravity', 'abc123', 'config'), { recursive: true });

  const init = box.cli('init', '--yes', '--codex-tier', 'pro-100', '--antigravity-tier', 'pro');
  assert.equal(init.status, 0, init.stderr);

  const primary = box.path('skills', 'auto-build', 'SKILL.md');
  const codexMirror = path.join(box.home, '.codex', 'skills', 'auto-build', 'SKILL.md');
  const agyMirror = path.join(box.home, '.t3', 'userdata', 'providers', 'antigravity', 'abc123', 'config', 'skills', 'auto-build', 'SKILL.md');
  assert.equal(read(codexMirror), read(primary));
  assert.equal(read(agyMirror), read(primary));

  const manifest = json(box.path('t3-auto-build.manifest.json'));
  assert.ok(manifest.skillMirrors[codexMirror]);
  assert.ok(manifest.skillMirrors[agyMirror]);

  // sync-models --apply keeps mirrors in sync with the primary SKILL.md.
  write(box.path('auto-build-availability.json'), {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ttlMs: 43_200_000,
    binaries: {},
    models: {},
    discoveredNew: [{ provider: 'codex', model: 'gpt-6.2-sol', family: 'gpt-sol', version: '6.2', supersedes: 'gpt-6.1-sol' }],
    missingConfigured: [],
  });
  const synced = box.cli('sync-models', '--apply');
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(read(codexMirror), /gpt-6\.2-sol/);
  assert.equal(read(codexMirror), read(primary));
  assert.equal(read(agyMirror), read(primary));

  // doctor reports mirrors ok.
  const doc = box.cli('doctor');
  assert.equal(doc.status, 0, doc.stdout);
  assert.match(doc.stdout, /ok\s+skill mirror:/);

  // uninstall removes unchanged mirrors.
  const un = box.cli('uninstall');
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(codexMirror), false);
  assert.equal(fs.existsSync(agyMirror), false);
});

test('--skill-targets supports custom roots, none, user-edit preservation, --force backup, and core cleanup', (t) => {
  const box = sandbox(t);
  const customA = path.join(box.dir, 'custom-a');
  const customB = path.join(box.dir, 'custom-b');
  const mirrorA = path.join(customA, 'auto-build', 'SKILL.md');
  const mirrorB = path.join(customB, 'auto-build', 'SKILL.md');

  assert.equal(box.cli('init', '--yes', '--skill-targets', ',').status, 2);
  assert.equal(parseSkillTargets('AUTO'), 'auto');
  assert.equal(parseSkillTargets('NONE'), 'none');

  const first = box.cli('init', '--yes', '--skill-targets', `${customA},${customB}`);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(read(mirrorA), read(box.path('skills', 'auto-build', 'SKILL.md')));
  assert.equal(read(mirrorB), read(box.path('skills', 'auto-build', 'SKILL.md')));

  // Hand-edit mirrorA; re-run without --force preserves it and doctor warns.
  fs.writeFileSync(mirrorA, '# custom edit\n');
  const docWarn = box.cli('doctor');
  assert.equal(docWarn.status, 0);
  assert.match(docWarn.stdout, /warn skill mirror differs/);

  const rerun = box.cli('init', '--yes', '--claude-tier', 'max');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(read(mirrorA), '# custom edit\n');
  assert.match(rerun.stdout, /warning: skipped skill mirror/);
  assert.equal(read(mirrorB), read(box.path('skills', 'auto-build', 'SKILL.md')));

  // --force backs up mirrorA and overwrites it.
  const forced = box.cli('init', '--yes', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(`${mirrorA}.bak`), '# custom edit\n');
  assert.equal(read(mirrorA), read(box.path('skills', 'auto-build', 'SKILL.md')));

  // Switching to --skill-targets none removes unchanged mirrors.
  const none = box.cli('init', '--yes', '--skill-targets', 'none');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(fs.existsSync(mirrorA), false);
  assert.equal(fs.existsSync(mirrorB), false);
  assert.equal(json(box.path('t3-auto-build.manifest.json')).skillTargets, 'none');

  // Re-enable customA, then switching to --modules core removes the mirror too.
  assert.equal(box.cli('init', '--yes', '--skill-targets', customA).status, 0);
  assert.equal(fs.existsSync(mirrorA), true);
  assert.equal(box.cli('init', '--yes', '--modules', 'core').status, 0);
  assert.equal(fs.existsSync(mirrorA), false);
});

test('doctor warns when a newly created provider skill dir is not yet mirrored', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  fs.mkdirSync(path.join(box.home, '.codex'), { recursive: true });
  const doc = box.cli('doctor');
  assert.equal(doc.status, 0);
  assert.match(doc.stdout, /warn provider skill dir not mirrored:/);
});

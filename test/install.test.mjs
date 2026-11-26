import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DEFAULTS } from '../hooks/_shared.mjs';
import { PRESETS, loadPreset, moduleFiles } from '../lib/install.mjs';
import { MODULES, hashOf } from '../lib/manifest.mjs';
import { safePath } from '../lib/paths.mjs';
import { promptOptions } from '../lib/prompt.mjs';
import { LADDERS, fillTemplate } from '../lib/render.mjs';
import { json, read, sandbox, tree, write } from './helpers.mjs';

const MANIFEST = 't3-auto-build.manifest.json';
const SKILL = ['skills', 'auto-build', 'SKILL.md'];
const ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const ok = (result) => assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
const commands = (settings) => Object.values(settings.hooks ?? {}).flat().flatMap((group) => group.hooks.map((hook) => hook.command));
const ours = (settings) => commands(settings).filter((command) => command.includes('--managed-by=t3-auto-build'));

test('presets allowlist 9, 6 and 3 models and defaults match tri-provider', () => {
  assert.deepEqual(PRESETS.map((name) => Object.values(loadPreset(name).allowlist).flat().length), [9, 6, 3]);
  for (const name of PRESETS) assert.deepEqual(Object.keys(loadPreset(name).ladders), LADDERS);
  assert.deepEqual(loadPreset('tri-provider').allowlist, DEFAULTS.allowlist);
  assert.deepEqual(loadPreset('tri-provider').bannedModels, DEFAULTS.bannedModels);
  const providers = {
    'tri-provider': ['Codex', 'Antigravity', 'Claude'],
    'claude-codex': ['Codex', 'Claude'],
    'claude-only': ['Claude'],
  };
  for (const preset of PRESETS) {
    const config = loadPreset(preset);
    assert.deepEqual(config.allowlist, Object.fromEntries(providers[preset].map((name) => [name, DEFAULTS.allowlist[name]])), preset);
    assert.deepEqual(config.bannedModels, DEFAULTS.bannedModels, preset);
  }
});

test('unresolved template slots throw', () => {
  assert.equal(fillTemplate('a {{x}}', { x: 1 }), 'a 1');
  assert.throws(() => fillTemplate('{{missing}}', {}), /unresolved template slot/);
  assert.throws(() => fillTemplate('{{ toString }}', {}), /unresolved/);
});

for (const preset of PRESETS) {
  for (const modules of MODULES) {
    test(`init ${preset} x ${modules}: files, byte-identical re-run, doctor, uninstall`, (t) => {
      const box = sandbox(t);
      const args = ['init', '--yes', '--preset', preset, '--modules', modules];
      ok(box.cli(...args));
      const first = tree(box.target);
      const expected = [...moduleFiles(modules), MANIFEST, ...(modules === 'core' ? [] : ['settings.json'])];
      assert.deepEqual(Object.keys(first).sort(), expected.sort());

      if (modules !== 'core') {
        const skill = read(box.path(...SKILL));
        assert.doesNotMatch(skill, /\{\{|\}\}/);
        const count = Object.values(loadPreset(preset).allowlist).flat().length;
        assert.match(skill, new RegExp(`Strict ${count}-Model Allowlist`));
        assert.ok(skill.includes(`${box.target.replace(/\\/g, '/')}/auto-build-cooldowns.json`));
        if (preset === 'claude-only') assert.doesNotMatch(skill, /gpt-|Gemini/);
        if (preset === 'claude-codex') assert.doesNotMatch(skill, /Gemini/);
        assert.equal(ours(json(box.path('settings.json'))).length, 4);
        assert.equal(json(box.path('settings.json')).env[ENV], '35');
      }

      ok(box.cli(...args));
      assert.deepEqual(tree(box.target), first);
      ok(box.cli('init', '--yes'));
      assert.deepEqual(tree(box.target), first);
      const checked = box.cli('doctor');
      ok(checked);
      assert.doesNotMatch(checked.stdout, /^fail/m);

      ok(box.cli('uninstall'));
      const left = Object.keys(tree(box.target)).filter((file) => !file.startsWith('settings.json'));
      assert.deepEqual(left, []);
      ok(box.cli('uninstall'));
    });
  }
}

test('settings merge keeps unrelated content, handles BOM, backs up once, and uninstall restores', (t) => {
  const box = sandbox(t);
  const original = {
    theme: 'dark',
    env: { OTHER: '1', [ENV]: '80' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [
          { type: 'command', command: 'node mine.js' },
          { type: 'command', command: 'node "old/pre-tool-use.mjs" --managed-by=t3-auto-build' },
        ] },
        { matcher: 'x', hooks: [{ type: 'command', command: 'node "dup.mjs" --managed-by=t3-auto-build' }] },
      ],
    },
  };
  const raw = `﻿${JSON.stringify(original, null, 4)}`;
  write(box.path('settings.json'), raw);
  ok(box.cli('init', '--yes', '--compaction', '60'));
  assert.equal(read(box.path('settings.json.bak')), raw);
  const merged = json(box.path('settings.json'));
  assert.equal(ours(merged).length, 4);
  assert.ok(commands(merged).includes('node mine.js'));
  assert.ok(commands(merged).includes('node other.js'));
  assert.deepEqual(merged.env, { OTHER: '1', [ENV]: '60' });

  const snapshot = tree(box.target);
  ok(box.cli('init', '--yes'));
  assert.deepEqual(tree(box.target), snapshot);

  // A second value must not replace the recorded original.
  ok(box.cli('init', '--yes', '--compaction=70'));
  assert.equal(json(box.path(MANIFEST)).env.prior, '80');
  ok(box.cli('uninstall'));
  const restored = json(box.path('settings.json'));
  assert.equal(restored.env[ENV], '80');
  assert.equal(restored.theme, 'dark');
  assert.deepEqual(commands(restored).sort(), ['node mine.js', 'node other.js']);
});

test('uninstall removes an env value it added and leaves a hand-changed one', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  ok(box.cli('uninstall'));
  assert.deepEqual(json(box.path('settings.json')), {});
  ok(box.cli('init', '--yes'));
  const settings = json(box.path('settings.json'));
  settings.env[ENV] = '99';
  write(box.path('settings.json'), settings);
  ok(box.cli('uninstall'));
  assert.deepEqual(json(box.path('settings.json')), { env: { [ENV]: '99' } });
});

test('invalid or non-object settings.json: exit 1, nothing written', (t) => {
  for (const bad of ['{ nope', '[1]', '"x"', 'null', '{"env": 3}', '{"hooks": {"PreToolUse": {}}}']) {
    const box = sandbox(t);
    write(box.path('settings.json'), bad);
    const result = box.cli('init', '--yes');
    assert.equal(result.status, 1, bad);
    assert.deepEqual(tree(box.target), { 'settings.json': bad });
  }
});

test('core modules never write settings.json', (t) => {
  const box = sandbox(t);
  write(box.path('settings.json'), '{ not even json');
  ok(box.cli('init', '--yes', '--modules', 'core'));
  ok(box.cli('uninstall'));
  assert.deepEqual(tree(box.target), { 'settings.json': '{ not even json' });
});

test('existing and edited files are skipped; --force backs up; uninstall keeps edits', (t) => {
  const box = sandbox(t);
  write(box.path('CLAUDE.md'), 'mine\n');
  const first = box.cli('init', '--yes');
  ok(first);
  assert.match(first.stdout, /skipped CLAUDE\.md/);
  assert.equal(read(box.path('CLAUDE.md')), 'mine\n');
  fs.appendFileSync(box.path('commands', 'fix.md'), 'edit\n');
  ok(box.cli('init', '--yes'));
  assert.match(read(box.path('commands', 'fix.md')), /edit\n$/);
  const kept = box.cli('uninstall');
  assert.match(kept.stdout, /kept \(modified since install\): commands\/fix\.md/);
  assert.deepEqual(Object.keys(tree(box.target)).filter((f) => !f.startsWith('settings')).sort(), ['CLAUDE.md', 'commands/fix.md']);

  ok(box.cli('init', '--yes', '--force'));
  assert.equal(read(box.path('CLAUDE.md.bak')), 'mine\n');
  assert.notEqual(read(box.path('CLAUDE.md')), 'mine\n');
  // A second forced overwrite must not destroy the first backup.
  write(box.path('CLAUDE.md'), 'second\n');
  ok(box.cli('init', '--yes', '--force'));
  assert.equal(read(box.path('CLAUDE.md.bak')), 'mine\n');
  assert.equal(read(box.path('CLAUDE.md.bak.1')), 'second\n');
});

test('edited config is the base: re-render, drop banned entries, flags override', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  const file = box.path('auto-build.config.json');
  const config = json(file);
  config.bannedModels.push('Claude Sonnet 5.5');
  config.ladders.tier1.unshift('not-allowlisted');
  write(file, config);
  const edited = read(file);
  ok(box.cli('init', '--yes'));
  assert.equal(read(file), edited);
  const skill = read(box.path(...SKILL));
  assert.match(skill, /Strict 8-Model Allowlist/);
  assert.doesNotMatch(skill, /not-allowlisted/);
  assert.match(skill, /Builder: `Gemini 4 Neon`\n    - `Shape B`[^\n]*Builder: `Gemini 4 Neon`/);

  ok(box.cli('init', '--yes', '--compaction', '55'));
  assert.equal(json(file).compactionThreshold, 55);
  assert.ok(json(file).bannedModels.includes('Claude Sonnet 5.5'));
  assert.equal(read(`${file}.bak`), edited);
  ok(box.cli('init', '--yes', '--preset', 'claude-codex'));
  assert.equal(json(file).preset, 'claude-codex');
  assert.equal(json(file).compactionThreshold, 55);
  assert.ok(json(file).bannedModels.includes('Claude Sonnet 5.5'));
  // The edited config survives uninstall.
  ok(box.cli('uninstall'));
  assert.ok(fs.existsSync(file));
});

test('empty ladder fails with a clear message and writes nothing', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), { preset: 'claude-only', bannedModels: ['Opus', 'Sonnet'] });
  const before = tree(box.target);
  const result = box.cli('init', '--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ladder "\w+" has no model left/);
  assert.deepEqual(tree(box.target), before);
});

test('invalid config: exit 1 without writes, --force backs it up', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), '{ broken');
  assert.equal(box.cli('init', '--yes').status, 1);
  assert.deepEqual(Object.keys(tree(box.target)), ['auto-build.config.json']);
  ok(box.cli('init', '--yes', '--force'));
  assert.equal(read(box.path('auto-build.config.json.bak')), '{ broken');
});

test('changing modules removes stale files and hooks, keeping edited ones', (t) => {
  const box = sandbox(t);
  write(box.path('settings.json'), { theme: 'dark' });
  ok(box.cli('init', '--yes'));
  fs.appendFileSync(box.path(...SKILL), 'edit\n');
  const result = box.cli('init', '--yes', '--modules', 'core');
  ok(result);
  assert.match(result.stdout, /kept \(modified since install\): skills\/auto-build\/SKILL\.md/);
  assert.deepEqual(json(box.path('settings.json')), { theme: 'dark' });
  assert.ok(!fs.existsSync(box.path('hooks')));
  assert.ok(fs.existsSync(box.path(...SKILL)));
  assert.deepEqual(Object.keys(json(box.path(MANIFEST)).files).sort(), [...moduleFiles('core'), 'skills/auto-build/SKILL.md'].sort());
  ok(box.cli('init', '--yes', '--modules', 'auto-build'));
  assert.ok(!fs.existsSync(box.path('CLAUDE.md')));
  assert.equal(ours(json(box.path('settings.json'))).length, 4);
});

test('manifest paths cannot escape the target', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes', '--modules', 'core'));
  const outside = path.join(box.dir, 'outside');
  const victim = path.join(outside, 'victim.txt');
  write(victim, 'keep');
  fs.symlinkSync(outside, box.path('link'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = json(box.path(MANIFEST));
  const hash = hashOf('keep'); // matches, so only the path check protects the victim
  const escapes = [victim, '../../outside/victim.txt', '..\\..\\outside\\victim.txt', 'link/victim.txt', '.. /x', 'C:x', ''];
  for (const entry of escapes) assert.equal(safePath(box.target, entry), null, entry);
  for (const entry of escapes) manifest.files[entry] = hash;
  write(box.path(MANIFEST), manifest);
  const result = box.cli('uninstall');
  ok(result);
  assert.match(result.stdout, /ignored unsafe manifest path/);
  assert.equal(read(victim), 'keep');
});

test('corrupt manifest: exit 1', (t) => {
  const box = sandbox(t);
  write(box.path(MANIFEST), '{"files": 1}');
  for (const command of [['init', '--yes'], ['uninstall'], ['doctor']]) assert.equal(box.cli(...command).status, 1);
});

test('--target wins over CLAUDE_CONFIG_DIR; the home default applies without either', (t) => {
  const box = sandbox(t);
  const other = path.join(box.dir, 'other target');
  ok(box.cli('init', '--yes', '--modules', 'core', '--target', other));
  assert.ok(fs.existsSync(path.join(other, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(box.target));
  delete box.env.CLAUDE_CONFIG_DIR;
  ok(box.cli('init', '--yes'));
  assert.ok(fs.existsSync(path.join(box.home, '.claude', 'CLAUDE.md')));
  assert.match(read(path.join(box.home, '.claude', ...SKILL)), /~\/\.claude\/auto-build-cooldowns\.json/);
});

test('a target path unsafe for hook commands is refused before writing', (t) => {
  const box = sandbox(t);
  const bad = path.join(box.dir, 'a$b');
  assert.equal(box.cli('init', '--yes', '--target', bad).status, 1);
  assert.ok(!fs.existsSync(bad));
});

test('the wired hook command runs through a shell with spaces in the path', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  const command = ours(json(box.path('settings.json'))).find((c) => c.includes('pre-tool-use'));
  const result = spawnSync(command, {
    shell: true,
    env: box.env,
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env' } }),
  });
  assert.equal(result.status, 2, result.stderr);
});

test('usage errors exit 2', (t) => {
  const box = sandbox(t);
  const cases = [
    [],
    ['nope'],
    ['init'],
    ['init', '--yes', '--preset', 'x'],
    ['init', '--yes', '--modules', 'x'],
    ...['0', '101', '1.5', 'abc', '-3', ''].map((n) => ['init', '--yes', `--compaction=${n}`]),
    ['init', '--yes', '--target'],
    ['init', '--bogus'],
    ['doctor', '--yes'],
  ];
  for (const args of cases) assert.equal(box.cli(...args).status, 2, args.join(' '));
  assert.match(box.cli('init').stderr, /--yes/);
  assert.ok(!fs.existsSync(box.target));
  ok(box.cli('--help'));
});

test('interactive prompts collect answers, keep defaults on Enter, reject bad input', async () => {
  const current = { modules: 'full', preset: 'tri-provider', compaction: 35 };
  const ask = (text) => {
    const input = new PassThrough();
    input.end(text);
    return promptOptions({}, current, input, new PassThrough());
  };
  assert.deepEqual(await ask('2\nclaude-only\nFoo, Bar ,\n40\n'), {
    modules: 'auto-build', preset: 'claude-only', banned: ['Foo', 'Bar'], compaction: 40,
  });
  assert.deepEqual(await ask('\n\n\n\n'), { banned: [] });
  assert.deepEqual(await ask('core\n'), { modules: 'core' });
  await assert.rejects(ask('9\n'), { exitCode: 2 });
  await assert.rejects(ask('\n\n\n0\n'), { exitCode: 2 });
  await assert.rejects(ask(''), { exitCode: 2 });
});

test('doctor fails on missing, broken or unwired files and warns on legacy hooks', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('doctor').status, 1);
  ok(box.cli('init', '--yes'));
  write(box.path('auto-build-cooldowns.json'), '{}');
  const settings = json(box.path('settings.json'));
  settings.hooks.Stop = [{ hooks: [{ type: 'command', command: 'powershell -File safety-guard.ps1' }] }];
  write(box.path('settings.json'), settings);
  const warned = box.cli('doctor');
  ok(warned);
  assert.match(warned.stdout, /warn old PowerShell hooks/);
  assert.equal(read(box.path('auto-build-cooldowns.json')), '{}', 'doctor must not touch cooldowns');

  const broken = [
    () => write(box.path('hooks', 't3-auto-build', 'pre-tool-use.mjs'), 'syntax error ('),
    () => fs.rmSync(box.path('hooks', 't3-auto-build', 'session-start.mjs')),
    () => write(box.path('settings.json'), '{ bad'),
    () => write(box.path('auto-build.config.json'), '{ bad'),
    () => write(box.path('settings.json'), {}),
  ];
  for (const breakIt of broken) {
    ok(box.cli('init', '--yes', '--force'));
    breakIt();
    const result = box.cli('doctor');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^fail/m);
    write(box.path('settings.json'), {});
    fs.rmSync(box.path('auto-build.config.json'), { force: true });
  }
});

test('doctor warns, without failing, when rg and sg are absent', (t) => {
  const box = sandbox(t);
  ok(box.cli('init', '--yes'));
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key];
  box.env.PATH = box.dir;
  const result = box.cli('doctor');
  ok(result);
  assert.match(result.stdout, /warn rg not found\. Install: winget .*brew .*apt /);
  assert.match(result.stdout, /warn sg not found\. Install: winget .*brew .*npm /);
});

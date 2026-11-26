import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { loadConfig, run, which } from '../hooks/_shared.mjs';
import { PRESETS, loadPreset } from '../lib/install.mjs';
import { json, read, sandbox, write } from './helpers.mjs';

const MINUTE = 60_000;
const at = (minutes) => new Date(Date.now() + minutes * MINUTE).toISOString();

function installed(t) {
  const box = sandbox(t);
  const result = box.cli('init', '--yes');
  assert.equal(result.status, 0, result.stderr);
  box.cooldowns = box.path('auto-build-cooldowns.json');
  return box;
}

const edit = (file, tool = 'Write') => ({ tool_name: tool, tool_input: { file_path: file } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const delegate = (input, tool = 'mcp__t3-code__delegate_task') => ({ tool_name: tool, tool_input: input });

function blocked(box, payload, pattern = /Blocked by/) {
  const result = box.hook('pre-tool-use', payload);
  assert.equal(result.status, 2, `${JSON.stringify(payload)} ${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
}

function allowed(box, payload) {
  const result = box.hook('pre-tool-use', payload);
  assert.equal(result.status, 0, `${JSON.stringify(payload)} ${result.stderr}`);
}

test('pre-tool-use blocks secret files', (t) => {
  const box = installed(t);
  const secrets = [
    '.env', 'app/.env', 'app\\.env.local', '.ENV', 'certs/server.pem', 'a.KEY', 'store.p12', 'store.pfx',
    'home/.ssh/id_rsa', 'id_ed25519.pub', 'x.pem\n',
  ];
  for (const file of secrets) blocked(box, edit(file), /secret\/credential/);
  for (const tool of ['Edit', 'MultiEdit', 'write']) blocked(box, edit('.env', tool));
  blocked(box, { Tool_Name: 'Write', Tool_Input: { File_Path: '.env' } });
  for (const file of ['src/env.js', '.environment', 'monkey', 'a.pem.md', 'README.md']) allowed(box, edit(file));
  allowed(box, edit('.env', 'Read'));
});

test('pre-tool-use blocks destructive commands', (t) => {
  const box = installed(t);
  const destructive = [
    'git push --force', 'git push -f', 'git push origin main --force', 'GIT PUSH --FORCE-with-lease',
    'git reset --hard HEAD~1', 'cd x && git  reset  --hard', 'rm -rf .', 'rm -rf /', 'rm -rf ~', 'rm -rf ./build', 'rm -rf \\tmp',
  ];
  for (const command of destructive) blocked(box, bash(command), /destructive command/);
  for (const command of ['git push origin main', 'git reset --soft HEAD~1', 'rm -rf build', 'rm file']) allowed(box, bash(command));
  // As in the original, "." never spans a newline.
  allowed(box, bash('git push origin main\necho --force'));
});

test('pre-tool-use blocks banned and non-allowlisted models', (t) => {
  const box = installed(t);
  for (const model of ['Argon', 'argon-2', 'Claude Fable 5', 'Mythos']) blocked(box, delegate({ model }), /is banned/);
  blocked(box, delegate({ model: 'gpt-4' }), /outside the 9-model allowlist/);
  blocked(box, delegate({ Model: 'gpt-4' }, 'delegate_task'));
  blocked(box, delegate({ model: { id: 'x' } }), /allowlist/);
  allowed(box, delegate({ model: 'Claude Opus 5.5' }));
  allowed(box, delegate({ model: 'claude opus 5.5' }));
  allowed(box, delegate({}));
  allowed(box, delegate({ model: '' }));
  allowed(box, delegate({ model: null, provider: 'Codex' }));
  blocked(box, delegate({ target: { model: 'gpt-4' } }), /outside the 9-model allowlist/);
  allowed(box, delegate({ target: { providerInstanceId: 'claudeAgent' } }));
  allowed(box, { tool_name: 'delegate_task' });
});

const nested = (target, top = {}) => delegate({ task: 'x', ...top, target });

test('pre-tool-use checks the nested T3 target and normalizes model names', (t) => {
  const box = installed(t);
  for (const model of ['claude-sonnet-5-5', 'gpt-5.6-luna', 'gemini-4-neon']) allowed(box, nested({ model }));
  blocked(box, nested({ model: 'claude-sonnet-55' }), /allowlist/);
  for (const model of ['claude-fable-5-2', 'gemini-4-argon']) blocked(box, nested({ model }), /is banned/);
  blocked(box, nested({ model: 'claude-fable-5-2' }, { model: 'claude-sonnet-5-5' }), /is banned/);
  blocked(box, nested({ model: 'claude-sonnet-5-5' }, { model: 'gpt-4' }), /'gpt-4' is outside/);
  write(box.path('auto-build.config.json'), { bannedModels: ['Sonnet 5.5'] });
  blocked(box, nested({ model: 'claude-sonnet-5-5' }), /is banned/);
});

test('pre-tool-use applies cooldowns to the nested T3 target', (t) => {
  const box = installed(t);
  const live = (scope) => ({ until_utc: at(10), scope, reason: 'cap' });
  write(box.cooldowns, { 'Claude Opus 5.5': live('model'), 'gpt-6-luna': live('model'), Claude: live('provider') });
  blocked(box, nested({ model: 'claude-opus-5-5' }), /'Claude Opus 5\.5' is on active cooldown/);
  blocked(box, nested({ model: 'GPT 6 Luna' }), /'gpt-6-luna' is on active cooldown/);
  blocked(box, nested({ providerInstanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }), /'Claude' is on active/);
  blocked(box, nested({ driverKind: 'CLAUDEAGENT' }), /'Claude' is on active/);
  allowed(box, nested({ providerInstanceId: 'codex', model: 'gpt-5.6-luna' }));

  write(box.cooldowns, { Codex: live('provider'), antigravity: live('provider') });
  blocked(box, nested({ providerInstanceId: 'codex-2' }), /'Codex' is on active/);
  blocked(box, nested({ providerInstanceId: 'work', driverKind: 'codex' }), /'Codex' is on active/);
  blocked(box, nested({ providerInstanceId: 'antigravity' }, { provider: 'Claude' }), /'antigravity' is on active/);
  allowed(box, nested({ providerInstanceId: 'claudeAgent' }));

  write(box.cooldowns, { 'codex-2': live('provider') });
  blocked(box, nested({ providerInstanceId: 'codex-2' }), /'codex-2' is on active/);
  allowed(box, nested({ providerInstanceId: 'codex', driverKind: 'codex' }));
});

test('keys missing from the config come from its preset, before and after init', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), { preset: 'claude-only' });
  assert.equal(box.cli('init', '--yes').status, 0);
  blocked(box, nested({ model: 'gpt-6-luna' }), /3-model allowlist/);
  allowed(box, nested({ model: 'claude-sonnet-5-5' }));
  for (const preset of PRESETS) {
    write(box.path('auto-build.config.json'), { preset });
    const { allowlist, bannedModels } = loadPreset(preset);
    assert.deepEqual(loadConfig(box.target), { allowlist, bannedModels }, preset);
  }
});

test('pre-tool-use honors the configured lists', (t) => {
  const box = installed(t);
  write(box.path('auto-build.config.json'), { allowlist: { Local: ['my-model'] }, bannedModels: ['evil'] });
  allowed(box, delegate({ model: 'my-model' }));
  blocked(box, delegate({ model: 'Claude Opus 5.5' }), /1-model allowlist/);
  blocked(box, delegate({ model: 'evil-1' }), /banned/);
});

test('pre-tool-use enforces model and provider cooldowns', (t) => {
  const box = installed(t);
  write(box.cooldowns, {
    'Claude Opus 5.5': { until_utc: at(10), scope: 'model', reason: 'rate limit' },
    'Gemini 4 Neon': { until_utc: at(-10), scope: 'model', reason: 'old' },
    Codex: { until_utc: at(60), scope: 'provider', reason: 'cap' },
  });
  const before = read(box.cooldowns);
  blocked(box, delegate({ model: 'claude opus 5.5' }), /cooldown.*rate limit/);
  blocked(box, delegate({ model: 'gpt-6-luna', provider: 'codex' }), /'Codex' is on active cooldown/);
  allowed(box, delegate({ model: 'gpt-6-luna' }));
  allowed(box, delegate({ model: 'Gemini 4 Neon' }));
  blocked(box, delegate({ provider: 'Codex' }), /'Codex' is on active cooldown/);
  assert.equal(read(box.cooldowns), before);
});

test('bad config or cooldowns fail open, while guards still work', (t) => {
  const box = installed(t);
  for (const bad of ['{ nope', '[]', '{"allowlist": 5, "bannedModels": "x"}']) {
    write(box.path('auto-build.config.json'), bad);
    blocked(box, edit('.env'));
    blocked(box, bash('rm -rf .'));
    blocked(box, delegate({ model: 'Argon' }));
    allowed(box, delegate({ model: 'Claude Opus 5.5' }));
    assert.match(box.hook('pre-tool-use', delegate({ model: 'Claude Opus 5.5' })).stderr, /default/);
  }
  fs.rmSync(box.path('auto-build.config.json'));
  blocked(box, delegate({ model: 'nope' }));
  for (const bad of ['{ nope', '[1]', '{"x": {"until_utc": "soon"}}', '{"x": null}']) {
    write(box.cooldowns, bad);
    const result = box.hook('pre-tool-use', delegate({ model: 'Claude Opus 5.5' }));
    assert.equal(result.status, 0, bad);
    assert.match(result.stderr, /ignoring auto-build-cooldowns/);
  }
});

test('malformed stdin passes every hook', (t) => {
  const box = installed(t);
  for (const name of ['pre-tool-use', 'post-tool-use', 'session-start', 'pre-compact']) {
    for (const input of ['', 'not json', '[1]', 'null', '{"tool_input": 5}']) {
      const result = box.hook(name, input);
      assert.equal(result.status, 0, `${name} ${input} ${result.stderr}`);
    }
  }
  assert.match(box.hook('pre-tool-use', 'not json').stderr, /malformed/);
  blocked(box, `﻿${JSON.stringify(edit('.env'))}`);
});

test('session-start prunes expired entries and reports active ones', (t) => {
  const box = installed(t);
  assert.equal(box.hook('session-start', {}).stdout, '');
  const live = { until_utc: at(9.5), scope: 'model', reason: 'rate limit' };
  write(box.cooldowns, `﻿${JSON.stringify({ A: live, B: { until_utc: at(-1), scope: 'model', reason: 'x' } })}`);
  const result = box.hook('session-start', {});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ACTIVE AUTO-BUILD COOLDOWNS (skip these models/providers): A (10m left: rate limit)\n');
  assert.deepEqual(json(box.cooldowns), { A: live });

  for (const expired of [{ B: { until_utc: at(-1), scope: 'model', reason: 'x' } }, {}, '']) {
    write(box.cooldowns, expired);
    const pruned = box.hook('session-start', {});
    assert.equal(pruned.status, 0);
    assert.equal(pruned.stdout, '');
    assert.ok(!fs.existsSync(box.cooldowns), 'expired-only file is removed');
  }
  for (const bad of ['{ nope', '[1]', '{"A": {"until_utc": "never"}}']) {
    write(box.cooldowns, bad);
    const kept = box.hook('session-start', {});
    assert.equal(kept.status, 0);
    assert.match(kept.stderr, /ignoring/);
    assert.equal(read(box.cooldowns), bad);
  }
});

const PRESERVED = `MANDATORY COMPACTION PRESERVATION RULES:
When summarizing this session, you MUST preserve verbatim:
1. STRICT 9-MODEL ALLOWLIST: Only gpt-5.6-luna, gpt-5.6-terra, gpt-6-luna (Codex); Gemini 4 Hydrogen, Gemini 4 Neon, Gemini 4 Carbon (Antigravity); Claude Haiku 5.5, Claude Sonnet 5.5, Claude Opus 5.5 (Claude). Argon and Fable/Mythos are strictly banned.
2. ORCHESTRATOR STATE (if $auto-build is active): Active inline flags (--fast/--strict/--plan-only/--budget/etc.), complexity tier (L0-L3), full REPO_BRIEF, IMPLEMENTER_PROVIDER, in-run EXHAUSTED models, current pipeline step, files modified so far, and exact failing test/audit file:line items.
3. COOLDOWN STATE: Any active rate-limit/quota cooldowns recorded in ~/.claude/auto-build-cooldowns.json.
4. ACTIVE SESSION STATE (all threads): Preserve a compact digest of:
   - Key architectural/constraint decisions already agreed upon.
   - Files already inspected or modified (so you do NOT re-read unchanged files after compaction).
   - Latest verification status (exact passing/failing test, lint, or typecheck commands and file:line errors).
   - Exact next action to resume cleanly without re-running discovery.
`;

test('pre-compact prints the rules verbatim for the default config dir', (t) => {
  const box = sandbox(t);
  box.target = path.join(box.home, '.claude');
  box.env.CLAUDE_CONFIG_DIR = box.target;
  assert.equal(box.cli('init', '--yes').status, 0);
  const hook = path.join(box.target, 'hooks', 't3-auto-build', 'pre-compact.mjs');
  const result = spawnSync(process.execPath, [hook], {
    cwd: box.dir,
    env: { ...box.env, GIT_CEILING_DIRECTORIES: path.dirname(box.dir) },
    encoding: 'utf8',
    input: '{}',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, PRESERVED);
});

describe('pre-compact git snapshot', { skip: !which('git') && 'git is not installed' }, () => {
  let git;
  before(() => {
    git = (box, cwd, ...args) => {
      const identity = ['-c', 'user.name=t', '-c', 'user.email=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
      const result = spawnSync(which('git'), [...identity, '-C', cwd, ...args], { env: box.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
  });
  const snapshot = (box, cwd, options) => {
    box.env.GIT_CEILING_DIRECTORIES = box.dir;
    const result = box.hook('pre-compact', { cwd }, options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MANDATORY/);
    return result.stdout.split('LIVE WORKTREE SNAPSHOT')[1];
  };

  test('repo, worktree, 20-line cap, process cwd fallback, silent outside git', (t) => {
    const box = installed(t);
    const repo = path.join(box.dir, 'my repo');
    fs.mkdirSync(repo);
    git(box, repo, 'init', '-q');
    assert.match(snapshot(box, repo), /\(clean working tree\)/);
    write(path.join(repo, 'a.txt'), '1');
    git(box, repo, 'add', '.');
    git(box, repo, 'commit', '-qm', 'one');
    write(path.join(repo, 'a.txt'), '2');
    assert.equal(snapshot(box, repo), ' (branch: main):\n M a.txt\n');

    const tree = path.join(box.dir, 'linked tree');
    git(box, repo, 'worktree', 'add', '-q', '-b', 'side', tree);
    assert.equal(snapshot(box, tree), ' (branch: side):\n(clean working tree)\n');

    for (let i = 10; i < 35; i += 1) write(path.join(repo, `f${i}.txt`), 'x');
    const lines = snapshot(box, repo).trimEnd().split('\n');
    assert.equal(lines.length, 22);
    assert.equal(lines[21], '... (+6 more files)');

    assert.match(snapshot(box, undefined, { cwd: repo }), /branch: main/);
    assert.match(snapshot(box, path.join(box.dir, 'missing'), { cwd: tree }), /branch: side/);
    assert.equal(snapshot(box, box.home), undefined);
  });
});

// A fake formatter that records its arguments, installed the way npm installs one on each platform.
function fakeTool(bin, name) {
  const script = path.join(bin, 'node_modules', name, 'cli.js');
  write(script, `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FORMAT_LOG, JSON.stringify(['${name}', ...process.argv.slice(2)]) + '\\n');
process.exit(1);
`);
  if (process.platform === 'win32') {
    write(path.join(bin, `${name}.cmd`), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\${name}\\cli.js" %*\r\n`);
  } else {
    // A shebang cannot hold a path with spaces, so wrap with sh.
    write(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
}

test('post-tool-use dispatches by extension in order, never interprets paths, always exits 0', (t) => {
  const box = installed(t);
  const bin = path.join(box.dir, 'tool bin');
  const log = path.join(box.dir, 'format.log');
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key];
  Object.assign(box.env, { PATH: bin, FORMAT_LOG: log });
  const format = (name) => {
    fs.rmSync(log, { force: true });
    const file = path.join(box.dir, name);
    write(file, 'x');
    const result = box.hook('post-tool-use', edit(file));
    assert.equal(result.status, 0, result.stderr);
    return fs.existsSync(log) ? read(log).trim().split('\n').map(JSON.parse).map((call) => call.map((a) => (a === file ? 'FILE' : a))) : [];
  };

  fs.mkdirSync(bin);
  assert.deepEqual(format('a.js'), [], 'no formatter available');
  for (const name of ['prettier', 'ruff', 'gofmt']) fakeTool(bin, name);
  for (const name of ['a.js', 'a.jsx', 'a.ts', 'a.TSX', 'a.json', 'a.css', 'a.md']) {
    assert.deepEqual(format(name), [['prettier', '--write', 'FILE']], name);
  }
  fakeTool(bin, 'biome');
  assert.deepEqual(format('a.ts'), [['biome', 'format', '--write', 'FILE']]);
  assert.deepEqual(format('a.py'), [['ruff', 'format', 'FILE']]);
  assert.deepEqual(format('a.go'), [['gofmt', '-w', 'FILE']]);
  assert.deepEqual(format('a.txt'), []);

  const marker = path.join(box.dir, 'pwned');
  const hostile = ['a & mkdir pwned & b.js','$(touch pwned).js', '`touch pwned`.js', '%PATH% ^! (1).js', "q';touch pwned;'.js"];
  for (const name of hostile) {
    assert.deepEqual(format(name), [['biome', 'format', '--write', 'FILE']], name);
    assert.ok(!fs.existsSync(marker), name);
  }
  const missing = box.hook('post-tool-use', edit(path.join(box.dir, 'gone.js')));
  assert.equal(missing.status, 0);
});

test('.cmd shims that cannot be unwrapped refuse unsafe arguments', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const box = sandbox(t);
  const shim = path.join(box.dir, 'odd tool.cmd');
  write(shim, '@echo off\r\necho %1\r\n');
  const options = { encoding: 'utf8', cwd: box.dir };
  assert.match(run(shim, ['plain name (1).js'], options).stdout, /"plain name \(1\)\.js"/);
  for (const bad of ['a&echo x.js', '%PATH%.js', 'a"b.js', 'a^b.js', 'a!b.js']) assert.equal(run(shim, [bad], options), null, bad);
});

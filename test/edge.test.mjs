import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, write, read, json } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliFile = path.join(root, 'bin', 'cli.mjs');

function cli(s, ...args) {
  if (!args.includes('--target')) args.push('--target', s.target);
  return spawnSync(process.execPath, [cliFile, ...args], {
    cwd: s.dir,
    env: { ...process.env, HOME: s.home, USERPROFILE: s.home, CLAUDE_CONFIG_DIR: s.target },
    encoding: 'utf8',
    input: '',
  });
}

function hook(s, name, payload, options = {}) {
  return spawnSync(process.execPath, [path.join(s.target, 'hooks', 't3-auto-build', `${name}.mjs`)], {
    cwd: s.dir,
    env: { ...process.env, HOME: s.home, USERPROFILE: s.home, CLAUDE_CONFIG_DIR: s.target },
    encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...options,
  });
}

function install(s, ...args) {
  const result = cli(s, 'init', '--yes', ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function t3Delegate(model) {
  return {
    tool_name: 'mcp__t3-code__delegate_task',
    tool_input: { task: 'x', target: { providerInstanceId: 'claudeAgent', model, options: { effort: 'high' } } },
  };
}

test('CLI resolves target precedence and installs into explicit target', (t) => {
  const s = sandbox(t);
  const alternate = path.join(s.dir, 'alternate');
  const result = cli(s, 'init', '--yes', '--target', alternate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(alternate, 'settings.json')), true);
  assert.equal(fs.existsSync(s.path('settings.json')), false);
});

test('CLI rejects invalid choices, percentages, and noninteractive init without --yes', (t) => {
  const s = sandbox(t);
  for (const args of [
    ['init', '--yes', '--preset', 'unknown'],
    ['init', '--yes', '--modules', 'unknown'],
    ['init', '--yes', '--compaction', '0'],
    ['init', '--yes', '--compaction', '101'],
    ['init'],
  ]) assert.equal(cli(s, ...args).status, 2, args.join(' '));
});

test('explicit target takes precedence over CLAUDE_CONFIG_DIR', (t) => {
  const s = sandbox(t);
  const explicit = path.join(s.dir, 'explicit');
  const result = cli(s, 'init', '--yes', '--target', explicit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(explicit, 'settings.json')), true);
});

test('init deep merges managed settings, backs up changed settings, and is byte-idempotent', (t) => {
  const s = sandbox(t);
  write(s.path('settings.json'), {
    untouched: { nested: true },
    env: { KEEP_ME: 'yes' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }] },
  });
  install(s);
  const first = read(s.path('settings.json'));
  const parsed = JSON.parse(first);
  assert.deepEqual(parsed.untouched, { nested: true });
  assert.equal(parsed.env.KEEP_ME, 'yes');
  assert.equal(Object.keys(parsed.env).filter((key) => key === 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE').length, 1);
  assert.ok(JSON.stringify(parsed.hooks).includes('--managed-by=t3-auto-build'));
  assert.ok(JSON.stringify(parsed.hooks).includes('user-hook'));
  assert.equal(fs.existsSync(s.path('settings.json.bak')), true);
  install(s);
  assert.equal(read(s.path('settings.json')), first);
});

test('invalid settings JSON fails without writing any installation files', (t) => {
  const s = sandbox(t);
  write(s.path('settings.json'), '{ invalid');
  const result = cli(s, 'init', '--yes');
  assert.equal(result.status, 1);
  assert.equal(read(s.path('settings.json')), '{ invalid');
  assert.deepEqual(fs.readdirSync(s.target), ['settings.json']);
});

test('settings JSON with a non-object top-level value fails without writes', (t) => {
  const s = sandbox(t);
  write(s.path('settings.json'), '[]');
  const result = cli(s, 'init', '--yes');
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readdirSync(s.target), ['settings.json']);
});

test('edited installed files are skipped, then backed up and replaced with --force', (t) => {
  const s = sandbox(t);
  install(s);
  const file = s.path('CLAUDE.md');
  const installed = read(file);
  write(file, 'user edit\n');
  const skipped = cli(s, 'init', '--yes');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(read(file), 'user edit\n');
  const forced = cli(s, 'init', '--yes', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(file), installed);
  assert.equal(read(`${file}.bak`), 'user edit\n');
});

test('uninstall removes only unchanged managed files and preserves user edits', (t) => {
  const s = sandbox(t);
  install(s);
  const file = s.path('CLAUDE.md');
  write(file, 'keep this edit\n');
  const result = cli(s, 'uninstall');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(file), 'keep this edit\n');
  assert.equal(fs.existsSync(s.path('hooks', 't3-auto-build')), false);
});

test('uninstall strips managed entries, keeps unrelated hooks, and preserves a changed environment value', (t) => {
  const s = sandbox(t);
  write(s.path('settings.json'), { env: { KEEP: 'x' }, hooks: { UserEvent: [{ command: 'mine' }] } });
  install(s);
  const settings = json(s.path('settings.json'));
  settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '99';
  write(s.path('settings.json'), settings);
  const result = cli(s, 'uninstall');
  assert.equal(result.status, 0, result.stderr);
  const after = json(s.path('settings.json'));
  assert.equal(after.env.KEEP, 'x');
  assert.equal(after.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '99');
  assert.deepEqual(after.hooks, { UserEvent: [{ command: 'mine' }] });
});

test('tampered manifest cannot cause uninstall to delete outside target', (t) => {
  const s = sandbox(t);
  install(s);
  const outside = path.join(s.dir, 'outside.txt');
  write(outside, 'safe');
  write(s.path('t3-auto-build.manifest.json'), { files: { '../../outside.txt': 'anything' } });
  const result = cli(s, 'uninstall');
  assert.equal(read(outside), 'safe');
});

test('pre-tool-use blocks secret file edits and destructive shell commands with useful errors', (t) => {
  const s = sandbox(t);
  install(s);
  for (const file_path of ['.env', 'keys/server.pem', 'id_rsa']) {
    const result = hook(s, 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path } });
    assert.equal(result.status, 2, file_path);
    assert.ok(result.stderr.trim(), file_path);
  }
  for (const command of ['git reset --hard', 'git push --force origin main', 'git push -f origin main', 'rm -rf /', 'rm -rf .']) {
    const result = hook(s, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.status, 2, command);
    assert.ok(result.stderr.trim(), command);
  }
});

test('secret and destructive guards still block when config or input is malformed', (t) => {
  const s = sandbox(t);
  install(s);
  write(s.path('auto-build.config.json'), '{bad');
  assert.equal(hook(s, 'pre-tool-use', '{bad').status, 0);
  assert.equal(hook(s, 'pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: 'private.pem' } }).status, 2);
  assert.equal(hook(s, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }).status, 2);
});

test('pre-tool-use allows benign actions and fails open for malformed cooldown data', (t) => {
  const s = sandbox(t);
  install(s);
  write(s.path('auto-build-cooldowns.json'), '{bad');
  for (const payload of [
    { tool_name: 'Read', tool_input: { file_path: 'src/app.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'git status --short' } },
    t3Delegate('claude-sonnet-5-5'),
    t3Delegate('gpt-6-luna'),
  ]) assert.equal(hook(s, 'pre-tool-use', payload).status, 0);
});

test('pre-tool-use blocks banned delegate models in the real nested T3 payload, case-insensitively', (t) => {
  const s = sandbox(t);
  install(s);
  const configFile = s.path('auto-build.config.json');
  const config = json(configFile);
  config.bannedModels = [...(config.bannedModels ?? []), 'fable'];
  write(configFile, config);
  const result = hook(s, 'pre-tool-use', t3Delegate('Claude-Fable-5-2'));
  assert.equal(result.status, 2);
  assert.ok(result.stderr.trim());
});

test('pre-tool-use blocks non-allowlisted models in the real nested T3 payload', (t) => {
  const s = sandbox(t);
  install(s);
  const result = hook(s, 'pre-tool-use', t3Delegate('model-not-in-any-allowlist'));
  assert.equal(result.status, 2);
  assert.ok(result.stderr.trim());
});

test('pre-compact prints preservation rules and limits status to 20 lines', (t) => {
  const s = sandbox(t);
  install(s);
  const repo = path.join(s.dir, 'payload repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  for (let i = 0; i < 25; i += 1) write(path.join(repo, `file-${i}.txt`), `${i}\n`);
  const result = hook(s, 'pre-compact', { cwd: repo });
  assert.equal(result.status, 0);
  for (let i = 1; i <= 4; i += 1) assert.match(result.stdout, new RegExp(`\\n${i}\\.`));
  const snapshot = result.stdout.split('LIVE WORKTREE SNAPSHOT:')[1] ?? '';
  assert.ok(snapshot.trim().split(/\r?\n/).length <= 20, 'status output is capped at 20 lines');
});

test('pre-compact is silent about git status outside a repository', (t) => {
  const s = sandbox(t);
  install(s);
  const plainDir = path.join(s.dir, 'plain');
  fs.mkdirSync(plainDir);
  const result = hook(s, 'pre-compact', { cwd: plainDir });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /fatal:|not a git repository/i);
});

test('post-tool-use always succeeds and treats shell metacharacters in file paths as data', (t) => {
  const s = sandbox(t);
  install(s);
  const sentinel = path.join(s.dir, 'should-not-exist');
  const file_path = `missing.txt; touch "${sentinel}"`;
  const result = hook(s, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path } });
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(sentinel), false);
});


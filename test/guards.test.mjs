import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandbox, write } from './helpers.mjs';

const delegate = (model) => ({ tool_name: 'delegate_task', tool_input: { model } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

function invoke(box, payload) {
  return box.hook('pre-tool-use', payload);
}

test('delegate guard blocks active model, provider, and heavy tier locks with reset details', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  write(box.path('auto-build-cooldowns.json'), {
    'model:claude-sonnet-5-5': { scope: 'model', window: 'burst', until, reason: 'model busy' },
    'provider:codex': { scope: 'provider', window: 'weekly', until, reason: 'weekly cap' },
    'tier:antigravity:heavy': { scope: 'tier', window: '5h', until, reason: 'heavy cap' },
  });

  for (const [payload, scope, reason] of [
    [delegate('Claude Sonnet 5.5'), 'model:claude-sonnet-5-5', 'model busy'],
    [delegate('gpt-6-luna'), 'provider:codex', 'weekly cap'],
    [delegate('Gemini 4 Carbon'), 'tier:antigravity:heavy', 'heavy cap'],
  ]) {
    const result = invoke(box, payload);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(scope), result.stderr);
    assert.ok(result.stderr.includes(until), result.stderr);
    assert.ok(result.stderr.includes(reason), result.stderr);
  }
});

test('model prefix infers provider and dated allowlist IDs still obey banned models', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  write(box.path('auto-build-cooldowns.json'), {
    'provider:codex': { scope: 'provider', window: 'weekly', until, reason: 'cap' },
  });
  let result = invoke(box, delegate('gpt-6-luna'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /provider:codex/);
  result = invoke(box, delegate('claude-opus-5-5-20261126'));
  assert.equal(result.status, 0, result.stderr);
  result = invoke(box, delegate('claude-fable-5-2-20261126'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /banned/);
});

test('destructive rm -rf targets are blocked while ordinary local cleanup is allowed', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  for (const command of ['rm -rf .', 'rm -rf ..', 'rm -rf ./', 'rm -rf ../', 'rm -rf build /']) {
    const result = invoke(box, bash(command));
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /destructive command/);
  }
  for (const command of ['rm -rf .tmp', 'rm -rf .sandbox-claude', 'rm -rf t3-auto-build']) {
    const result = invoke(box, bash(command));
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});

test('session start prunes expired locks and reports active countdowns', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const activeUntil = new Date(Date.now() + 8 * 60_000).toISOString();
  write(box.path('auto-build-cooldowns.json'), {
    'model:gpt-6-luna': { scope: 'model', window: 'burst', until: activeUntil, reason: 'busy' },
    'model:old': { scope: 'model', window: 'burst', until: new Date(Date.now() - 60_000).toISOString(), reason: 'expired' },
  });
  const result = box.hook('session-start', {});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACTIVE AUTO-BUILD COOLDOWNS/);
  assert.match(result.stdout, /gpt-6-luna/);
  assert.match(result.stdout, /busy/);
  assert.doesNotMatch(result.stdout, /expired/);
});

test('pre-compact preserves orchestrator state location and required fields', (t) => {
  const box = sandbox(t);
  assert.equal(box.cli('init', '--yes').status, 0);
  const file = `${box.dir}\\.claude\\auto-build-state.json`;
  write(file, { flags: ['--strict'], completedWaves: [1, 2], modifiedFiles: ['src/a.mjs'], remaining: ['wave 3'], blockers: ['lint'] });
  const result = box.hook('pre-compact', { cwd: box.dir });
  assert.equal(result.status, 0, result.stderr);
  for (const expected of [file, 'flags', 'completedWaves', 'modifiedFiles', 'remaining', 'blockers']) {
    assert.ok(result.stdout.includes(expected), `${expected}\n${result.stdout}`);
  }
});

test('a provider lock cannot be bypassed with a custom instance id', async () => {
  const { isLocked } = await import('../hooks/_quota.mjs');
  const data = { 'provider:codex': { scope: 'provider', window: 'weekly', until: new Date(Date.now() + 60_000).toISOString() } };
  for (const provider of [undefined, 'work', 'openai']) {
    assert.equal(isLocked(data, { provider, model: 'gpt-6-luna' })?.key, 'provider:codex', String(provider));
  }
  assert.equal(isLocked(data, { provider: 'claudeAgent', model: 'claude-opus-5-5' }), null);
});

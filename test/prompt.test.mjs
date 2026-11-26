import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { initPrompts } from '../lib/prompt.mjs';
import { sandbox, write } from './helpers.mjs';

const detect = () => ({ preset: 'claude-only', providers: { claude: { binary: 'claude' }, codex: {}, antigravity: {} } });
const ask = async (target, text, options = {}) => {
  const input = new PassThrough();
  input.end(text);
  let shown = '';
  const output = new PassThrough();
  output.on('data', (chunk) => { shown += chunk; });
  const answers = await initPrompts(target, options, { detect, input, output });
  return { answers, shown };
};

test('init asks one tier per provider, defaulting to none without a binary', async (t) => {
  const box = sandbox(t);
  // modules, 3 tiers, parent, banned, compaction
  const { answers } = await ask(box.target, '\n\n\n\nsonnet\n\n\n');
  assert.deepEqual(answers.subscriptions, { claude: 'pro', codex: 'none', antigravity: 'none' });
  assert.equal(answers.parent, 'sonnet');
  assert.equal(answers.preset, undefined);
  for (const key of ['allowUsageCredits', 'allowFastModes', 'verifiedOrg']) assert.equal(answers[key], undefined);
});

test('a flagged tier is not asked and tier warnings are shown', async (t) => {
  const box = sandbox(t);
  const { answers, shown } = await ask(box.target, '\ngo\n\n\n\n\n', { claudeTier: 'pro' });
  assert.doesNotMatch(shown, /claude subscription tier/);
  assert.match(shown, /warning: codex go: desktop-only/);
  assert.deepEqual(answers.subscriptions, { claude: 'pro', codex: 'go', antigravity: 'none' });
});

test('all none asks the preset; a v1 config is kept on Enter', async (t) => {
  const box = sandbox(t);
  const none = await ask(box.target, '\nnone\n\n\n\n\n\n');
  assert.equal(none.answers.preset, 'claude-only');
  write(box.path('auto-build.config.json'), { preset: 'claude-only' });
  const kept = await ask(box.target, '\n\n\n\n\n\n\n');
  assert.deepEqual(kept.answers.subscriptions, {});
  assert.equal(kept.answers.preset, undefined);
  await assert.rejects(ask(box.target, '\nbogus\n'), { exitCode: 2 });
});

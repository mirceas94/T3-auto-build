import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSettings, unmergeSettings } from '../lib/settings.mjs';

const merge = (data, previous, parent = { model: 'opus', effort: 'high' }) =>
  mergeSettings(data, 'C:/config', 35, previous, parent);

test('parent settings are written when absent and unrelated settings stay intact', () => {
  const { data, env } = merge({ theme: 'dark', extra: { keep: true } });
  assert.equal(data.model, 'claude-opus-5-5');
  assert.equal(data.effortLevel, 'high');
  assert.deepEqual(data.extra, { keep: true });
  assert.deepEqual(env.settings, {
    model: { had: false, prior: null, installed: 'claude-opus-5-5' },
    effortLevel: { had: false, prior: null, installed: 'high' },
  });
});

test('user-selected model survives while an unchanged managed effort updates on rerun', () => {
  const first = merge({ model: 'my-model' });
  const rerun = merge(first.data, first.env, { model: 'sonnet', effort: 'medium' });
  assert.equal(rerun.data.model, 'my-model');
  assert.equal(rerun.data.effortLevel, 'medium');
  assert.equal(rerun.env.settings.model, undefined);
  assert.deepEqual(rerun.env.settings.effortLevel, { had: false, prior: null, installed: 'medium' });

  const updated = merge({ theme: 'dark' });
  const second = merge(updated.data, updated.env, { model: 'sonnet', effort: 'low' });
  assert.equal(second.data.model, 'claude-sonnet-5-5');
  assert.equal(second.data.effortLevel, 'low');
  assert.equal(second.env.settings.model.installed, 'claude-sonnet-5-5');
  assert.equal(second.env.settings.effortLevel.installed, 'low');
});

test('unmerge removes only unchanged managed settings and keeps unrelated keys', () => {
  const first = merge({ theme: 'dark', model: 'original-model' });
  const edited = { ...first.data, effortLevel: 'user-effort', extra: 7 };
  const result = unmergeSettings(edited, first.env);
  assert.equal(result.model, 'original-model');
  assert.equal(result.effortLevel, 'user-effort');
  assert.equal(result.theme, 'dark');
  assert.equal(result.extra, 7);
});

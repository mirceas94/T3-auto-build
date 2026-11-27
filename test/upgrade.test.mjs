import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { install, uninstall, upgrade } from '../lib/install.mjs';
import { CliError } from '../lib/paths.mjs';
import { resolveTiers } from '../lib/plans.mjs';
import { summaryTable } from '../lib/prompt.mjs';
import { json, read, sandbox, tree, write } from './helpers.mjs';

const CONFIG = 'auto-build.config.json';
const AVAILABILITY = 'auto-build-availability.json';
const SKILL = ['skills', 'auto-build', 'SKILL.md'];
const run = (target, options) => {
  const lines = [];
  install(target, options, (line) => lines.push(line));
  return lines.join('\n');
};
const quiet = { log: () => {} };
const tiers = { claudeTier: 'max', codexTier: 'pro-200', antigravityTier: 'pro' };

test('tier options write a v2 config and the parent settings', (t) => {
  const box = sandbox(t);
  const output = run(box.target, tiers);
  const config = json(box.path(CONFIG));
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.subscriptions, { claude: 'max', codex: 'pro-200', antigravity: 'pro' });
  assert.match(output, /provider +\| tier/);
  const settings = json(box.path('settings.json'));
  assert.equal(settings.model, 'claude-opus-5-5');
  assert.equal(settings.effortLevel, 'medium');
  assert.ok(json(box.path('t3-auto-build.manifest.json')).env.settings.model);

  // A plain re-run keeps the config, its edits and the parent settings.
  write(box.path(CONFIG), { ...config, ladders: { ...config.ladders, tier1: ['gpt-6-luna'] } });
  run(box.target, {});
  assert.deepEqual(json(box.path(CONFIG)).ladders.tier1, ['gpt-6-luna']);
  assert.equal(json(box.path('settings.json')).model, 'claude-opus-5-5');
  run(box.target, { subscriptions: config.subscriptions, parent: 'sonnet' });
  assert.deepEqual(json(box.path(CONFIG)).ladders.tier1, ['gpt-6-luna']);
  assert.equal(json(box.path('settings.json')).model, 'claude-sonnet-5-5');

  // Flags beat prompt answers, which beat the existing config; a rebuild is backed up.
  run(box.target, { codexTier: 'plus', subscriptions: { codex: 'pro-100', antigravity: 'free' } });
  assert.deepEqual(json(box.path(CONFIG)).subscriptions, { claude: 'max', codex: 'plus', antigravity: 'free' });
  assert.equal(json(box.path(CONFIG)).parent.model, 'sonnet');
  assert.ok(fs.existsSync(box.path(`${CONFIG}.bak`)));

  uninstall(box.target, () => {});
  assert.equal(json(box.path('settings.json')).model, undefined);
});

test('a user-set settings model is preserved', (t) => {
  const box = sandbox(t);
  write(box.path('settings.json'), { model: 'my-model' });
  run(box.target, tiers);
  assert.equal(json(box.path('settings.json')).model, 'my-model');
  assert.equal(json(box.path('settings.json')).effortLevel, 'medium');
});

test('tiers without a CLI or without usage credits warn and add no models', (t) => {
  const box = sandbox(t);
  const free = run(box.target, { claudeTier: 'free', codexTier: 'plus' });
  assert.match(free, /warning: claude free: Claude Code requires Pro/);
  const go = path.join(box.home, 'go');
  assert.doesNotMatch(run(go, { claudeTier: 'pro', codexTier: 'go' }), /warning: codex/);
  assert.deepEqual(json(path.join(go, CONFIG)).allowlist.Codex, ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  const api = path.join(box.home, 'api');
  assert.match(run(api, { claudeTier: 'pro', codexTier: 'api' }), /--allow-usage-credits/);
  assert.deepEqual(json(path.join(api, CONFIG)).allowlist.Codex, []);
});

test('unusable tier selections are CliErrors that write nothing', (t) => {
  const box = sandbox(t);
  for (const options of [
    { claudeTier: 'pro', parent: 'fable' }, { claudeTier: 'nope' }, { claudeTier: 'free' }, { parent: 'opus' },
  ]) {
    assert.throws(() => run(box.target, options), CliError, JSON.stringify(options));
  }
  assert.ok(!fs.existsSync(box.target));
});

test('upgrade converts a v1 config once, with a backup and a re-rendered skill', (t) => {
  const box = sandbox(t);
  run(box.target, {});
  const config = json(box.path(CONFIG));
  config.bannedModels = ['Argon', 'Fable/Mythos', 'Foo'];
  config.modelIds = { 'Claude Opus 5.5': 'opus-id' };
  config.tiers = { claude: { plan: 'max' } };
  config.ladders.builderA = ['gpt-5.6-luna', 'Claude Sonnet 5.5@high'];
  write(box.path(CONFIG), config);
  const original = read(box.path(CONFIG));
  const skill = read(box.path(...SKILL));

  const result = upgrade(box.target, quiet);
  assert.equal(result.upgraded, true);
  assert.equal(result.backup, box.path(`${CONFIG}.bak`));
  assert.equal(read(result.backup), original);
  const next = json(box.path(CONFIG));
  assert.equal(next.schemaVersion, 2);
  assert.deepEqual(next.subscriptions, { claude: 'pro', codex: 'plus', antigravity: 'plus' });
  assert.deepEqual(next.userBannedModels, ['Foo']);
  assert.deepEqual(next.bannedModels, ['Foo']);
  assert.deepEqual(next.modelIds, config.modelIds);
  assert.equal(next.tiers, undefined);
  assert.equal(next.ladders.builderA[1], 'claude-sonnet-5-5@high');
  assert.ok(!next.ladders.builderA.includes('gpt-5.6-luna'));
  assert.notEqual(read(box.path(...SKILL)), skill);
  assert.match(read(box.path(...SKILL)), /claude-sonnet-5-5/);
  assert.equal(json(box.path('settings.json')).model, 'claude-sonnet-5-5');

  const after = tree(box.target);
  assert.equal(upgrade(box.target, quiet).upgraded, false);
  assert.deepEqual(tree(box.target), after);
});

test('upgrade keeps hand-edited managed files and refuses configs it cannot read', (t) => {
  const box = sandbox(t);
  assert.throws(() => upgrade(box.target, quiet), /nothing to upgrade/);
  run(box.target, {});
  write(box.path(...SKILL), 'mine');
  upgrade(box.target, quiet);
  assert.equal(read(box.path(...SKILL)), 'mine');
  for (const text of ['{ bad', '[]', '{"schemaVersion":3}']) {
    write(box.path(CONFIG), text);
    const before = tree(box.target);
    assert.throws(() => upgrade(box.target, quiet), CliError, text);
    assert.deepEqual(tree(box.target), before);
  }
});

test('uninstall removes the availability cache and nothing outside the target', (t) => {
  const box = sandbox(t);
  run(box.target, {});
  write(box.path(AVAILABILITY), '{}');
  write(path.join(box.home, AVAILABILITY), 'outside');
  uninstall(box.target, () => {});
  assert.ok(!fs.existsSync(box.path(AVAILABILITY)));
  assert.equal(read(path.join(box.home, AVAILABILITY)), 'outside');
});

test('summaryTable has a row per provider, the parent and the warnings', () => {
  const text = summaryTable(resolveTiers({ claude: 'max', codex: 'api' }));
  for (const provider of ['claude', 'codex', 'antigravity']) assert.match(text, new RegExp(`^${provider} +\\|`, 'm'));
  assert.match(text, /^parent: opus \(medium\)$/m);
  assert.match(text, /^warning: codex api:/m);
  assert.doesNotMatch(text, /antigravity none:/);
});

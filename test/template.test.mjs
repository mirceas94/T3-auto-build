import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { renderSkill } from '../lib/render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const template = read('skills/auto-build/SKILL.md.tmpl');
const v1 = JSON.parse(read('presets/tri-provider.json'));
const v2 = toConfig(resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });

for (const [name, config] of [['v1 preset', v1], ['v2 resolved', v2]]) {
  test(`renders ${name} with the v2 runtime rules`, () => {
    const skill = renderSkill(template, config, path.join(root, '.claude'));
    assert.doesNotMatch(skill, /\{\{|\}\}/);
    assert.match(skill, /t3-auto-build check-models/);
    assert.match(skill, /t3-auto-build availability mark <provider:model> plan-restricted --ttl 24h/);
    assert.ok(skill.includes(`at most ${config.maxParallelBuilders ?? 2} builders in parallel`));
    assert.match(skill, /auto-build-availability\.json/);
  });
}

// v1 configs have no scarce models, so only the v2 render can name one.
test('v2 render names the cross-hosted scarce model', () => {
  assert.match(renderSkill(template, v2, root), /antigravity:claude-opus-5-5/);
});

test('template and core CLAUDE.md hardcode no roster model ids', () => {
  for (const source of [template, read('core/CLAUDE.md')]) {
    assert.doesNotMatch(source.replace(/\{\{[^{}]*\}\}/g, ''), /gpt-\d|gemini-\d|claude-(haiku|sonnet|opus|fable)/i);
  }
});

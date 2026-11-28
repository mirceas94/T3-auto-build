import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPreset } from '../lib/install.mjs';
import { resolveTiers, toConfig } from '../lib/plans.mjs';
import { renderSkill } from '../lib/render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'skills/auto-build/SKILL.md.tmpl'), 'utf8');

test('renders v1 presets and current template without unresolved slots', () => {
  const rendered = renderSkill(template, loadPreset('tri-provider'), path.join(root, '.claude'));
  assert.doesNotMatch(rendered, /\{\{[^{}]*\}\}/);
  assert.match(rendered, /Strict 9-Model Allowlist/);
});

test('renders v2 cross-hosted and scarce ladder entries with new template values', () => {
  const resolved = resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'ultra-20x' });
  const config = toConfig(resolved);
  const slots = '{{builderA}}\n{{architect}}\n{{maxParallelBuilders}}\n{{availabilityPath}}\n{{scarceModels}}\n{{retiredModels}}';
  const rendered = renderSkill(slots, config, path.join(root, '.claude'));

  assert.match(rendered, /antigravity:claude-(?:sonnet|opus)-5-5/);
  assert.match(rendered, /maxParallelBuilders|\n6\n/);
  assert.match(rendered, /auto-build-availability\.json/);
  assert.match(rendered, /claude:claude-fable-5-2/);
  assert.match(rendered, /gpt-5\.5/);

  for (const ladder of ['builderA', 'testerA', 'auditorA', 'builderB', 'testerB', 'auditorB', 'architect', 'dualAudit']) {
    const refs = config.ladders[ladder];
    const firstScarce = refs.findIndex((ref) => {
      const [refProvider, model] = ref.includes(':') ? ref.split(':') : [null, ref];
      const id = model.split('@')[0];
      const provider = refProvider ?? (id.startsWith('claude-') ? 'claude' : id.startsWith('gpt-') ? 'codex' : 'antigravity');
      return config.models.some((item) => item.model === id
        && item.provider === provider && item.scarceQuota);
    });
    if (firstScarce >= 0) assert.ok(refs.slice(firstScarce).every((ref) => {
      const [refProvider, model] = ref.includes(':') ? ref.split(':') : [null, ref];
      const id = model.split('@')[0];
      const provider = refProvider ?? (id.startsWith('claude-') ? 'claude' : id.startsWith('gpt-') ? 'codex' : 'antigravity');
      return config.models.some((item) => item.model === id
        && item.provider === provider && item.scarceQuota);
    }), `${ladder} has a standard entry after a scarce entry`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATALOG, MODELS, PARENTS, POOLS, PROVIDERS, RETIRED_MODELS, getTier, matchRetired, resolveTiers, supersedes, toConfig,
} from '../lib/plans.mjs';
import { LADDERS } from '../lib/render.mjs';

const TIER_IDS = {
  claude: ['none', 'free', 'pro', 'max', 'ultra', 'team-standard', 'team-premium', 'api'],
  codex: ['none', 'free', 'go', 'plus', 'pro-100', 'pro-200', 'pro-500', 'business', 'api'],
  antigravity: ['none', 'free', 'plus', 'pro-trial', 'pro', 'ultra-5x', 'ultra-20x'],
};
const UNSUPPORTED = { claude: ['none', 'free'], codex: ['none'], antigravity: ['none'] };
const ROLES = ['triage', 'planner', 'builder', 'tester', 'auditor'];
const allTiers = () => Object.entries(CATALOG).flatMap(([provider, tiers]) => Object.values(tiers).map((tier) => ({ provider, tier })));

/** { provider, model, effort } of a ladder entry; bare ids are native. */
function parse(entry) {
  const [ref, effort] = entry.split('@');
  const [a, b] = ref.split(':');
  return b ? { provider: a, model: b, effort } : { provider: MODELS[a].provider, model: a, effort };
}
const isScarce = ({ provider, model }) => MODELS[model].provider !== provider || MODELS[model].scarceQuota;

function assertScarceLast(ladder, label) {
  const flags = ladder.map((entry) => isScarce(parse(entry)));
  const first = flags.indexOf(true);
  if (first >= 0) assert.ok(flags.slice(first).every(Boolean), `${label}: ${ladder.join(', ')}`);
  assert.equal(flags[0], false, `${label} starts scarce`);
}

test('catalog lists every tier with the full shape', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex', 'antigravity']);
  for (const provider of PROVIDERS) assert.deepEqual(Object.keys(CATALOG[provider]), TIER_IDS[provider]);
  for (const { provider, tier } of allTiers()) {
    const label = `${provider}/${tier.id}`;
    assert.equal(getTier(provider, tier.id), tier);
    assert.equal(typeof tier.label, 'string', label);
    assert.equal(typeof tier.cliSupported, 'boolean', label);
    assert.ok(tier.warning === null || typeof tier.warning === 'string', label);
    assert.equal(typeof tier.usageBilled, 'boolean', label);
    assert.equal(typeof tier.windows.fiveHour, 'boolean', label);
    assert.equal(typeof tier.windows.weekly, 'boolean', label);
    for (const [pool, window] of Object.entries(tier.windows.subCaps)) {
      assert.ok(POOLS.includes(pool) && ['5h', 'weekly'].includes(window), label);
    }
    assert.ok(tier.parentDefault === null || (PARENTS[tier.parentDefault.model] && tier.parentDefault.effort), label);
    assert.ok(Array.isArray(tier.parentOptions), label);
    assert.ok(Number.isInteger(tier.maxParallelBuilders) && tier.maxParallelBuilders >= 0, label);
    assert.deepEqual(Object.keys(tier.ladders), ROLES, label);
    for (const model of tier.models) {
      assert.deepEqual(Object.keys(model), ['provider', 'model', 'pool', 'scarceQuota', 'family', 'version'], label);
      assert.equal(model.provider, provider, label);
      assert.equal(model.family, MODELS[model.model].family, label);
    }
    for (const role of ROLES) {
      assert.equal(tier.ladders[role].length > 0, tier.cliSupported, `${label} ${role}`);
      for (const entry of tier.ladders[role]) {
        assert.ok(entry.startsWith(`${provider}:`), `${label} ${entry}`);
        assert.ok(tier.models.some((m) => m.model === parse(entry).model), `${label} ${entry}`);
      }
      if (tier.cliSupported) assertScarceLast(tier.ladders[role], `${label} ${role}`);
    }
  }
});

test('CATALOG and MODELS are deep-frozen', () => {
  assert.ok(Object.isFrozen(CATALOG.claude.pro.models[0]));
  assert.ok(Object.isFrozen(CATALOG.claude.ultra.windows.subCaps));
  assert.ok(Object.isFrozen(CATALOG.antigravity.pro.ladders.builder));
  assert.ok(Object.isFrozen(MODELS['claude-fable-5-2']));
});

test('resolveTiers output is a mutable copy', () => {
  const resolved = resolveTiers({ claude: 'max' });
  resolved.models[0].pool = 'x';
  resolved.parent.effort = 'high';
  resolved.allowlist.Claude.push('x');
  assert.equal(CATALOG.claude.max.models[0].pool, 'standard');
  assert.equal(CATALOG.claude.max.parentDefault.effort, 'medium');
});

test('CLI-less tiers yield no models, no builders and a warning', () => {
  for (const [provider, ids] of Object.entries(UNSUPPORTED)) {
    const partner = provider === 'claude' ? { codex: 'plus' } : { claude: 'pro' };
    for (const id of ids) {
      const tier = getTier(provider, id);
      assert.equal(tier.cliSupported, false);
      assert.deepEqual(tier.models, []);
      assert.equal(tier.maxParallelBuilders, 0);
      const resolved = resolveTiers({ ...partner, [provider]: id });
      assert.ok(resolved.models.every((m) => m.provider !== provider));
      assert.ok(resolved.warnings.some((w) => w.startsWith(`${provider} `)), `${provider}/${id}`);
    }
  }
  assert.match(getTier('claude', 'free').warning, /Claude Code requires Pro or higher \(or api\)/);
  assert.match(getTier('codex', 'none').warning, /no Codex subscription selected/);
});

test('rosters per tier', () => {
  const ids = (provider, id) => getTier(provider, id).models.map((m) => m.model);
  assert.deepEqual(ids('claude', 'pro'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(ids('claude', 'max'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']);
  assert.deepEqual(ids('claude', 'ultra'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']);
  assert.deepEqual(ids('claude', 'team-premium'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(ids('codex', 'plus'), ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.2-sol']);
  for (const id of ['pro-100', 'pro-200', 'pro-500', 'business', 'api']) {
    assert.deepEqual(ids('codex', id), ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.2-astra'], id);
  }
  assert.deepEqual(ids('antigravity', 'free'), ['gemini-4-hydrogen', 'gemini-4-neon']);
  for (const id of ['plus', 'pro-trial']) {
    assert.deepEqual(ids('antigravity', id), ['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon'], id);
  }
  for (const id of ['pro', 'ultra-5x', 'ultra-20x']) {
    const cross = getTier('antigravity', id).models.filter((m) => m.pool === 'third-party-claude');
    assert.deepEqual(cross.map((m) => [m.provider, m.model, m.scarceQuota]), [
      ['antigravity', 'claude-sonnet-5-5', true], ['antigravity', 'claude-opus-5-5', true],
    ], id);
  }
});

test('claude parent defaults and --parent validation', () => {
  assert.deepEqual(resolveTiers({ claude: 'pro' }).parent, { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(resolveTiers({ claude: 'max' }).parent, { model: 'opus', effort: 'medium' });
  assert.deepEqual(resolveTiers({ claude: 'ultra' }).parent, { model: 'opus', effort: 'medium' });
  assert.deepEqual(resolveTiers({ claude: 'max' }, { parent: null }).parent, { model: 'opus', effort: 'medium' });
  assert.deepEqual(resolveTiers({ claude: 'max' }, { parent: 'fable' }).parent, { model: 'fable', effort: 'medium' });
  assert.deepEqual(resolveTiers({ claude: 'ultra' }, { parent: 'fable' }).parent, { model: 'fable', effort: 'medium' });
  assert.deepEqual(getTier('claude', 'ultra').parentOptions, ['sonnet', 'opus', 'fable']);
  assert.throws(() => resolveTiers({ claude: 'pro' }, { parent: 'fable' }), /fable/);
  assert.throws(() => resolveTiers({ claude: 'pro' }, { parent: 'toString' }), /toString/);
  assert.throws(() => resolveTiers({ codex: 'plus' }, { parent: 'opus' }), /opus/);
  assert.equal(resolveTiers({ codex: 'plus' }).parent, null);
});

test('unknown tiers and selections without a usable model throw', () => {
  assert.throws(() => getTier('claude', 'gold'), /unknown claude tier "gold"; expected one of none, free, pro/);
  assert.throws(() => getTier('claude', 'toString'), /unknown claude tier/);
  assert.throws(() => getTier('mistral', 'pro'), /unknown provider "mistral"/);
  assert.throws(() => resolveTiers({ codex: 'gold' }), /unknown codex tier "gold"/);
  assert.throws(() => resolveTiers(), /no CLI-capable subscription/);
  assert.throws(() => resolveTiers({ claude: 'free', codex: 'none' }), /no CLI-capable subscription/);
  assert.throws(() => resolveTiers({ claude: 'api' }), /no CLI-capable subscription/);
});

test('usage-billed tiers need allowUsageCredits', () => {
  const blocked = resolveTiers({ claude: 'api', codex: 'plus' });
  assert.deepEqual(blocked.allowlist.Claude, []);
  assert.ok(blocked.planRestrictedModels.includes('claude:claude-fable-5-2'));
  assert.ok(blocked.warnings.some((w) => /allow-usage-credits/.test(w)));
  assert.equal(blocked.parent, null);
  assert.equal(blocked.maxParallelBuilders, getTier('codex', 'plus').maxParallelBuilders);

  const allowed = resolveTiers({ claude: 'api' }, { allowUsageCredits: true });
  assert.ok(allowed.allowlist.Claude.includes('claude-fable-5-2'));
  assert.deepEqual(allowed.planRestrictedModels, []);
  assert.ok(allowed.warnings.some((w) => /billed per token/.test(w)));
  assert.deepEqual(getTier('claude', 'api').windows, { fiveHour: false, weekly: false, subCaps: {} });
});

test('every selection gives all slots, scarce entries last, only allowlisted models', () => {
  for (const claude of TIER_IDS.claude) {
    for (const codex of TIER_IDS.codex) {
      for (const antigravity of TIER_IDS.antigravity) {
        const label = `${claude}/${codex}/${antigravity}`;
        let resolved;
        try {
          resolved = resolveTiers({ claude, codex, antigravity }, { allowUsageCredits: true });
        } catch (error) {
          assert.ok(UNSUPPORTED.claude.includes(claude) && UNSUPPORTED.codex.includes(codex) && antigravity === 'none', label);
          assert.match(error.message, /no CLI-capable subscription/);
          continue;
        }
        assert.deepEqual(Object.keys(resolved.ladders), LADDERS, label);
        assert.ok(resolved.maxParallelBuilders >= 1 && resolved.maxParallelBuilders <= 6, label);
        const known = new Set(resolved.models.map((m) => `${m.provider}:${m.model}`));
        for (const [slot, ladder] of Object.entries(resolved.ladders)) {
          assert.ok(ladder.length > 0, `${label} ${slot}`);
          assertScarceLast(ladder, `${label} ${slot}`);
          for (const entry of ladder) {
            const { provider, model } = parse(entry);
            assert.ok(known.has(`${provider}:${model}`), `${label} ${entry}`);
            assert.equal(entry.includes(':'), MODELS[model].provider !== provider, entry);
          }
        }
      }
    }
  }
});

test('slot assignment rotates providers and applies v1 efforts', () => {
  const { ladders, maxParallelBuilders } = resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' });
  const first = (slot) => parse(ladders[slot][0]).provider;
  assert.notEqual(first('builderA'), first('builderB'));
  assert.notEqual(first('testerA'), first('builderA'));
  assert.notEqual(first('testerB'), first('builderB'));
  assert.notEqual(first('auditorA'), first('builderA'));
  assert.deepEqual(ladders.tier1, ladders.commandRunner);
  assert.deepEqual(ladders.builderA.slice(0, 3), ['claude-sonnet-5-5', 'gpt-6.2-sol', 'gemini-4-neon']);
  assert.ok(ladders.architect.filter((e) => !isScarce(parse(e))).every((e) => e.endsWith('@high')));
  for (const slot of ['auditorA', 'auditorB']) {
    assert.ok(ladders[slot][0].endsWith('@high'));
    assert.ok(!ladders[slot][1].includes('@'));
  }
  assert.ok(ladders.builderA.includes('antigravity:claude-opus-5-5@medium'));
  assert.ok(ladders.builderA.includes('claude-fable-5-2@medium'));
  assert.deepEqual(ladders.dualAudit, ['claude-opus-5-5@high', 'gpt-6.2-sol@high']);
  assert.equal(maxParallelBuilders, 6);
  assert.deepEqual(resolveTiers({ antigravity: 'pro' }).ladders.dualAudit, ['gemini-4-carbon@high']);
});

test('nothing retired appears in the catalog', () => {
  assert.ok(RETIRED_MODELS.length > 0);
  const ids = [
    ...Object.keys(MODELS),
    ...Object.values(PARENTS),
    ...allTiers().flatMap(({ tier }) => [
      ...tier.models.map((m) => m.model),
      ...Object.values(tier.ladders).flat().map((entry) => parse(entry).model),
    ]),
  ];
  assert.deepEqual(ids.filter((id) => matchRetired(id)), []);
});

test('supersedes compares numeric versions within a family', () => {
  assert.equal(supersedes('6.1', '6'), true);
  assert.equal(supersedes('6', '6.1'), false);
  assert.equal(supersedes('6.10', '6.9'), true);
  assert.equal(supersedes('6.0', '6'), false);
  assert.equal(supersedes('6', '6'), false);
  assert.equal(supersedes({ family: 'gpt-sol', version: '6.2' }, MODELS['gpt-6.1-sol']), true);
  assert.equal(supersedes({ family: 'gpt-luna', version: '7' }, MODELS['gpt-6.1-sol']), false);
});

test('toConfig emits a v2 config', () => {
  const resolved = resolveTiers({ claude: 'max', codex: 'plus', antigravity: 'pro' });
  const config = toConfig(resolved, { userBannedModels: ['Neon'], allowFastModes: true });
  assert.deepEqual(Object.keys(config), [
    'schemaVersion', 'preset', 'subscriptions', 'parent', 'allowFastModes', 'allowUsageCredits', 'verifiedOrg', 'models',
    'allowlist', 'retiredModels', 'planRestrictedModels', 'userBannedModels', 'bannedModels', 'ladders',
    'maxParallelBuilders', 'defaultModel', 'defaultEffort', 'compactionThreshold', 'modelIds', 'discovery',
  ]);
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.preset, 'tri-provider');
  assert.equal(config.bannedModels, config.userBannedModels);
  assert.deepEqual(config.bannedModels, ['Neon']);
  assert.equal(config.allowFastModes, true);
  assert.equal(config.compactionThreshold, 35);
  assert.equal(config.defaultModel, 'claude-sonnet-5-5');
  assert.deepEqual(config.retiredModels, [...RETIRED_MODELS]);
  assert.deepEqual(config.ladders, resolved.ladders);
  assert.ok(!('tiers' in config));

  assert.equal(toConfig(resolveTiers({ claude: 'pro', codex: 'plus' })).preset, 'claude-codex');
  assert.equal(toConfig(resolveTiers({ claude: 'pro' })).preset, 'claude-only');
  const gemini = toConfig(resolveTiers({ antigravity: 'free' }));
  assert.equal(gemini.preset, 'custom');
  assert.equal(gemini.defaultModel, gemini.ladders.builderA[0]);
});

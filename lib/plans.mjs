// Subscription catalog and ladder resolution. Pure: no fs, no child_process.
import { RETIRED_MODELS, matchRetired } from '../hooks/_shared.mjs';

export { RETIRED_MODELS, matchRetired };

export const PROVIDERS = ['claude', 'codex', 'antigravity'];
export const POOLS = ['standard', 'fable', 'astra', 'third-party-claude'];
export const PARENTS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };

const ROLES = ['triage', 'planner', 'builder', 'tester', 'auditor'];
const DISPLAY = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const PARENT_EFFORT = 'medium';
const MAX_BUILDERS = 6;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const model = (provider, family, version, pool = 'standard') =>
  ({ provider, family, version, pool, scarceQuota: pool !== 'standard' });

export const MODELS = deepFreeze({
  'claude-haiku-5-5': model('claude', 'claude-haiku', '5.5'),
  'claude-sonnet-5-5': model('claude', 'claude-sonnet', '5.5'),
  'claude-opus-5-5': model('claude', 'claude-opus', '5.5'),
  'claude-fable-5-2': model('claude', 'claude-fable', '5.2', 'fable'),
  'gpt-6-luna': model('codex', 'gpt-luna', '6'),
  'gpt-6.1-terra': model('codex', 'gpt-terra', '6.1'),
  'gpt-6.1-sol': model('codex', 'gpt-sol', '6.1'),
  'gpt-6-astra': model('codex', 'gpt-astra', '6', 'astra'),
  'gemini-4-hydrogen': model('antigravity', 'gemini-hydrogen', '4'),
  'gemini-4-neon': model('antigravity', 'gemini-neon', '4'),
  'gemini-4-carbon': model('antigravity', 'gemini-carbon', '4'),
});

// Role preference per hosting; a tier keeps the ids it has.
const PREFERENCE = {
  claude: {
    triage: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    planner: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'],
    builder: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'],
    tester: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'],
    auditor: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'],
  },
  codex: {
    triage: ['gpt-6-luna', 'gpt-6.1-terra'],
    planner: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra'],
    builder: ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
    tester: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'],
    auditor: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra'],
  },
  antigravity: {
    triage: ['gemini-4-hydrogen', 'gemini-4-neon'],
    planner: ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'claude-opus-5-5', 'claude-sonnet-5-5'],
    builder: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    tester: ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-carbon', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    auditor: ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  },
};

const NO_WINDOWS = { fiveHour: false, weekly: false, subCaps: {} };

/** Cross-hosted, or from a capped pool: overflow/escalation only. Takes "provider:model[@effort]". */
function isOverflow(ref) {
  const [provider, rest] = ref.split(':');
  const { provider: native, scarceQuota } = MODELS[rest.split('@')[0]];
  return native !== provider || scarceQuota;
}

function tierLadders(provider, models) {
  const ids = new Set(models.map((m) => m.model));
  return Object.fromEntries(ROLES.map((role) => {
    const refs = PREFERENCE[provider][role].filter((id) => ids.has(id)).map((id) => `${provider}:${id}`);
    const ordered = [...refs.filter((ref) => !isOverflow(ref)), ...refs.filter(isOverflow)];
    return [role, ordered.map((ref, index) => {
      if (isOverflow(ref)) return `${ref}@medium`;
      return role === 'planner' || (role === 'auditor' && index === 0) ? `${ref}@high` : ref;
    })];
  }));
}

function tier(provider, id, label, {
  ids = [], cross = [], builders = 0, warning, usageBilled = false, windows, subCaps = {}, parent, parentOptions = [],
} = {}) {
  const entry = (name, overrides) => {
    const { family, version, pool, scarceQuota } = MODELS[name];
    return { provider, model: name, pool, scarceQuota, family, version, ...overrides };
  };
  const models = [
    ...ids.map((name) => entry(name)),
    ...cross.map((name) => entry(name, { pool: 'third-party-claude', scarceQuota: true })),
  ];
  const cliSupported = models.length > 0;
  return {
    id,
    label,
    cliSupported,
    warning: warning ?? (cliSupported ? null : `no ${DISPLAY[provider]} subscription selected`),
    usageBilled,
    windows: windows ?? (cliSupported ? { fiveHour: true, weekly: true, subCaps } : NO_WINDOWS),
    parentDefault: parent ? { model: parent, effort: PARENT_EFFORT } : null,
    parentOptions,
    models,
    maxParallelBuilders: builders,
    ladders: tierLadders(provider, models),
  };
}

const API = { usageBilled: true, windows: NO_WINDOWS, warning: 'API usage is billed per token' };

// shortcut: builder counts and quota windows are estimates, tune when providers publish per-tier limits.
function claudeTiers() {
  const base = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  const all = [...base, 'claude-fable-5-2'];
  const two = ['sonnet', 'opus'];
  const three = [...two, 'fable'];
  const make = (id, label, options) => tier('claude', id, label, options);
  return [
    make('none', 'No Claude plan'),
    make('free', 'Claude Free', { warning: 'Claude Code requires Pro or higher (or api)' }),
    make('pro', 'Claude Pro', { ids: base, parent: 'sonnet', parentOptions: two, builders: 1 }),
    make('max', 'Claude Max', { ids: base, parent: 'opus', parentOptions: two, builders: 2 }),
    make('ultra', 'Claude Ultra', { ids: all, parent: 'opus', parentOptions: three, builders: 3, subCaps: { fable: 'weekly' } }),
    make('team-standard', 'Claude Team Standard', { ids: base, parent: 'sonnet', parentOptions: two, builders: 1 }),
    make('team-premium', 'Claude Team Premium', { ids: base, parent: 'opus', parentOptions: two, builders: 2 }),
    make('api', 'Claude API', { ...API, ids: all, parent: 'opus', parentOptions: three, builders: 3 }),
  ];
}

function codexTiers() {
  const base = ['gpt-6-luna', 'gpt-6.1-terra'];
  const all = [...base, 'gpt-6.1-sol', 'gpt-6-astra'];
  const desktopOnly = 'desktop-only; Codex CLI unavailable';
  const make = (id, label, options) => tier('codex', id, label, options);
  const full = (id, label, builders) => make(id, label, { ids: all, builders, subCaps: { astra: 'weekly' } });
  return [
    make('none', 'No Codex plan'),
    make('free', 'ChatGPT Free', { warning: desktopOnly }),
    make('go', 'ChatGPT Go', { warning: desktopOnly }),
    make('plus', 'ChatGPT Plus', { ids: base, builders: 1 }),
    full('pro-100', 'ChatGPT Pro $100', 2),
    full('pro-200', 'ChatGPT Pro $200', 2),
    full('pro-500', 'ChatGPT Pro $500', 3),
    full('business', 'ChatGPT Business', 2),
    make('api', 'OpenAI API', { ...API, ids: all, builders: 3 }),
  ];
}

function antigravityTiers() {
  const base = ['gemini-4-hydrogen', 'gemini-4-neon'];
  const all = [...base, 'gemini-4-carbon'];
  const make = (id, label, options) => tier('antigravity', id, label, options);
  const withClaude = (id, label, builders) => make(id, label, {
    ids: all, cross: ['claude-sonnet-5-5', 'claude-opus-5-5'], builders, subCaps: { 'third-party-claude': 'weekly' },
  });
  return [
    make('none', 'No Antigravity plan'),
    make('free', 'Antigravity Free', { ids: base, builders: 1 }),
    make('plus', 'Google AI Plus', { ids: all, builders: 1 }),
    make('pro-trial', 'Google AI Pro (trial)', { ids: all, builders: 1 }),
    withClaude('pro', 'Google AI Pro', 2),
    withClaude('ultra-5x', 'Google AI Ultra 5x', 2),
    withClaude('ultra-20x', 'Google AI Ultra 20x', 3),
  ];
}

const byId = (tiers) => Object.fromEntries(tiers.map((t) => [t.id, t]));

export const CATALOG = deepFreeze({ claude: byId(claudeTiers()), codex: byId(codexTiers()), antigravity: byId(antigravityTiers()) });

export function getTier(provider, tierId) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"; expected one of ${PROVIDERS.join(', ')}`);
  if (!Object.hasOwn(CATALOG[provider], tierId)) {
    throw new Error(`unknown ${provider} tier "${tierId}"; expected one of ${Object.keys(CATALOG[provider]).join(', ')}`);
  }
  return CATALOG[provider][tierId];
}

/** Native ids are bare in resolved ladders; cross-hosted ones keep their "provider:" prefix. */
function ladderEntry(ref) {
  const [provider, rest] = ref.split(':');
  return MODELS[rest.split('@')[0]].provider === provider ? rest : ref;
}

/** Round-robin over providers beginning at lists[start]; overflow entries go last. */
function interleave(lists, start) {
  const rotated = lists.map((_, i) => lists[(i + start) % lists.length]);
  const roundRobin = (groups) => Array.from(
    { length: Math.max(...groups.map((g) => g.length)) },
    (_, i) => groups.flatMap((g) => g.slice(i, i + 1)),
  ).flat();
  return [
    ...roundRobin(rotated.map((list) => list.filter((ref) => !isOverflow(ref)))),
    ...roundRobin(rotated.map((list) => list.filter(isOverflow))),
  ];
}

function resolveLadders(tiers) {
  const slot = (role, start) => interleave(tiers.map((t) => t.ladders[role]), start).map(ladderEntry);
  // Every provider's top auditor carries @high in the catalog; a merged ladder keeps it on its first entry only.
  const auditor = (start) => slot('auditor', start).map((entry, index) => {
    const [ref, effort] = entry.split('@');
    if (index === 0) return `${ref}@high`;
    return effort === 'high' ? ref : entry;
  });
  return {
    tier1: slot('triage', 0),
    commandRunner: slot('triage', 0),
    builderA: slot('builder', 0),
    testerA: slot('tester', 1),
    auditorA: auditor(1),
    builderB: slot('builder', 1),
    testerB: slot('tester', 2),
    auditorB: auditor(0),
    architect: slot('planner', 0),
    dualAudit: tiers.slice(0, 2).map((t) => ladderEntry(t.ladders.auditor[0])),
  };
}

function resolveParent(claude, requested) {
  if (requested == null) return claude ? { ...claude.parentDefault } : null;
  if (!claude?.parentOptions.includes(requested)) {
    const options = claude?.parentOptions.join(', ') ?? 'none (needs an eligible Claude tier)';
    throw new Error(`--parent ${requested} is not available on the selected Claude tier; options: ${options}`);
  }
  return { model: requested, effort: claude.parentDefault.effort };
}

export function resolveTiers({ claude = 'none', codex = 'none', antigravity = 'none' } = {}, { parent, allowUsageCredits = false } = {}) {
  const subscriptions = { claude, codex, antigravity };
  const warnings = [];
  const planRestrictedModels = [];
  const eligible = new Map();
  for (const provider of PROVIDERS) {
    const selected = getTier(provider, subscriptions[provider]);
    if (selected.warning) warnings.push(`${provider} ${selected.id}: ${selected.warning}`);
    if (selected.usageBilled && !allowUsageCredits) {
      warnings.push(`${provider} ${selected.id}: models excluded; pass --allow-usage-credits to use them`);
      planRestrictedModels.push(...selected.models.map((m) => `${provider}:${m.model}`));
    } else if (selected.cliSupported) {
      eligible.set(provider, selected);
    }
  }
  if (eligible.size === 0) throw new Error(`no CLI-capable subscription (${warnings.join('; ')})`);

  const tiers = [...eligible.values()];
  const models = tiers.flatMap((t) => t.models.map((m) => ({ ...m })));
  const allowlist = Object.fromEntries(PROVIDERS.map(
    (provider) => [DISPLAY[provider], models.filter((m) => m.provider === provider).map((m) => m.model)],
  ));
  return {
    subscriptions,
    parent: resolveParent(eligible.get('claude'), parent),
    models,
    allowlist,
    ladders: resolveLadders(tiers),
    maxParallelBuilders: Math.min(MAX_BUILDERS, tiers.reduce((sum, t) => sum + t.maxParallelBuilders, 0)),
    planRestrictedModels,
    warnings,
  };
}

function presetFor(allowlist) {
  const active = PROVIDERS.filter((p) => allowlist[DISPLAY[p]].length > 0).join(',');
  return { 'claude,codex,antigravity': 'tri-provider', 'claude,codex': 'claude-codex', claude: 'claude-only' }[active] ?? 'custom';
}

export function toConfig(resolved, {
  preset, allowFastModes = false, allowUsageCredits = false, verifiedOrg = false, userBannedModels = [], compactionThreshold = 35,
} = {}) {
  const { subscriptions, parent, models, allowlist, planRestrictedModels, ladders, maxParallelBuilders } = structuredClone(resolved);
  const banned = [...userBannedModels];
  return {
    schemaVersion: 2,
    preset: preset ?? presetFor(allowlist),
    subscriptions,
    parent,
    allowFastModes,
    allowUsageCredits,
    verifiedOrg,
    models,
    allowlist,
    retiredModels: [...RETIRED_MODELS],
    planRestrictedModels,
    userBannedModels: banned,
    bannedModels: banned,
    ladders,
    maxParallelBuilders,
    defaultModel: allowlist.Claude.includes(PARENTS.sonnet) ? PARENTS.sonnet : ladders.builderA[0].split('@')[0],
    defaultEffort: 'medium',
    compactionThreshold,
    modelIds: {},
    discovery: {},
  };
}

const versionOf = (value) => String(value?.version ?? value).split('.').map(Number);

/** Numerically newer dotted version; objects must also share a family. */
export function supersedes(a, b) {
  if (a?.family !== b?.family) return false;
  const [left, right] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

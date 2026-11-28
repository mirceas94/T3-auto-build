// Presets, config validation and the config an install writes. Reads only; never writes.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CONFIG_FILE, canonicalProvider, isAllowlist, isObject, isStringList, isSupportedSchema, readJson,
} from '../../hooks/_shared.mjs';
import { CliError, PACKAGE_ROOT } from '../paths.mjs';
import { CATALOG, PROVIDERS, resolveTiers, toConfig } from '../plans.mjs';
import { HOOKS, HOOKS_DIR } from '../settings.mjs';

export const PRESETS = ['tri-provider', 'claude-codex', 'claude-only'];
const EFFORTS = ['low', 'medium', 'high'];
export const SKILL = 'skills/auto-build/SKILL.md';
export const CORE_FILES = ['CLAUDE.md', 'rules/code-quality.md', 'commands/fix.md', 'commands/review.md', 'commands/handover.md'];
export const HOOK_FILES = ['_catalog.mjs', '_shared.mjs', '_quota.mjs', ...HOOKS.map((hook) => hook.script)]
  .map((name) => `${HOOKS_DIR}/${name}`);

export const wantsCore = (modules) => modules !== 'auto-build';
export const wantsAuto = (modules) => modules !== 'core';

/** Every file a module selection owns, relative to the target. */
export const moduleFiles = (modules) => [
  ...(wantsCore(modules) ? CORE_FILES : []),
  ...(wantsAuto(modules) ? [SKILL, ...HOOK_FILES, CONFIG_FILE] : []),
];

export const loadPreset = (name) => readJson(path.join(PACKAGE_ROOT, 'presets', `${name}.json`));
export const union = (a, b) => [...new Map([...a, ...b].map((item) => [item.toLowerCase(), item])).values()];

const SHARING = ['provider', 'heavy-tier-only'];
const optional = (value, valid) => value === undefined || valid(value);
const isBoolean = (v) => typeof v === 'boolean';
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isTier = (tier) => isObject(tier)
  && optional(tier.plan, (v) => typeof v === 'string')
  && optional(tier.sharing, (v) => SHARING.includes(v))
  && optional(tier.resetDay, (v) => typeof v === 'string' || Number.isInteger(v))
  && optional(tier.heavyModels, isStringList);
const isModels = (v) => Array.isArray(v) && v.every((m) => isObject(m) && isStringList([m.provider, m.model])
  && optional(m.pool, (p) => typeof p === 'string')
  && optional(m.scarceQuota, isBoolean));
const isTelemetry = (v) => isObject(v) && optional(v.enabled, isBoolean) && optional(v.maxBytes, isCount);
const isPreflight = (v) => isObject(v) && optional(v.ttl, isCount);
// Same rules as the hooks apply in loadConfig.
export const isQuota = (v) => isObject(v)
  && optional(v.minRemainingPct, (p) => Number.isFinite(p) && p >= 0 && p <= 100)
  && optional(v.ttlMs, isPositiveInt)
  && optional(v.claudeUsage, isBoolean)
  && optional(v.burstLockMs, isCount);
export const QUOTA_RULE = 'an object with optional "minRemainingPct" (0 to 100), boolean "claudeUsage", '
  + 'positive integer "ttlMs" and non-negative integer "burstLockMs"';
const isToggle = (v) => isBoolean(v) || isObject(v);

export function configProblem(config) {
  if (!isAllowlist(config.allowlist)) return '"allowlist" must map provider names to lists of model names';
  if (!isStringList(config.bannedModels)) return '"bannedModels" must be a list of model names';
  if (!isObject(config.ladders) || !Object.values(config.ladders).every(isStringList)) return '"ladders" must map ladder names to lists';
  const percent = config.compactionThreshold;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return '"compactionThreshold" must be an integer from 1 to 100';
  if (!EFFORTS.includes(config.defaultEffort)) return `"defaultEffort" must be one of ${EFFORTS.join(', ')}`;
  if (typeof config.defaultModel !== 'string') return '"defaultModel" must be a model name';
  if (!optional(config.tiers, (v) => isObject(v) && Object.values(v).every(isTier))) {
    return `"tiers" must map provider names to settings (sharing: ${SHARING.join(' or ')}; heavyModels: list of model names)`;
  }
  if (!optional(config.modelIds, (v) => isObject(v) && isStringList(Object.values(v)))) {
    return '"modelIds" must map model names to CLI model ids';
  }
  if (!optional(config.models, isModels)) {
    return 'models entries must include provider and model names (optional string "pool", boolean "scarceQuota")';
  }
  for (const key of ['retiredModels', 'planRestrictedModels', 'userBannedModels']) {
    if (!optional(config[key], isStringList)) return `"${key}" must be a list of model names`;
  }
  if (!optional(config.allowFastModes, isBoolean)) return '"allowFastModes" must be a boolean';
  if (!optional(config.subscriptions, isObject)) return '"subscriptions" must map provider names to tiers';
  if (!optional(config.maxParallelBuilders, isCount)) return '"maxParallelBuilders" must be a non-negative integer';
  if (!optional(config.telemetry, isTelemetry)) {
    return '"telemetry" must be an object with optional boolean "enabled" and non-negative integer "maxBytes"';
  }
  if (!optional(config.preflight, isPreflight)) {
    return 'preflight must be an object with a non-negative integer "ttl"';
  }
  if (!optional(config.quota, isQuota)) return `"quota" must be ${QUOTA_RULE}`;
  if (!optional(config.catalogOverrides, isToggle)) return '"catalogOverrides" must be a boolean or an object';
  return null;
}

/** The config with missing fields filled from its preset. */
export function completeConfig(config) {
  const preset = loadPreset(PRESETS.includes(config.preset) ? config.preset : PRESETS[0]);
  const ladders = config.ladders === undefined
    ? { ...preset.ladders }
    : isObject(config.ladders) ? { ...preset.ladders, ...config.ladders } : config.ladders;
  return { ...preset, ...config, ladders };
}

/** What a v1 install is assumed to pay for: a low paid tier with a CLI. */
export const ASSUMED_TIERS = { claude: 'pro', codex: 'plus', antigravity: 'plus' };
const OLD_DEFAULT_BANS = ['argon', 'fable/mythos'];

export function inferSubscriptions(config) {
  const present = new Set(Object.entries(config.allowlist)
    .filter(([, models]) => models.length > 0)
    .map(([name]) => canonicalProvider(name)));
  return Object.fromEntries(PROVIDERS.map((p) => [p, present.has(p) ? ASSUMED_TIERS[p] : 'none']));
}

/** The subscription selection to resolve, or null to keep the config as it is. Flags > prompts > existing config. */
export function tierRequest(existing, options) {
  const tiered = isSupportedSchema(existing);
  const flags = Object.fromEntries(PROVIDERS.map((p) => [p, options[`${p}Tier`]]));
  const prompted = Object.values(options.subscriptions ?? {});
  const wanted = Object.values(flags).some((tier) => tier !== undefined)
    || (tiered ? prompted.length > 0 || Boolean(options.parent) || options.allowUsageCredits !== undefined
      : prompted.some((tier) => tier !== 'none'));
  if (!wanted) {
    if (options.parent) throw new CliError('--parent needs a subscription tier (--claude-tier)', 2);
    return null;
  }
  const base = tiered ? existing.subscriptions : existing && inferSubscriptions(completeConfig(existing));
  return {
    subscriptions: Object.fromEntries(PROVIDERS.map(
      (p) => [p, flags[p] ?? options.subscriptions?.[p] ?? base?.[p] ?? 'none'],
    )),
    allowUsageCredits: options.allowUsageCredits ?? existing?.allowUsageCredits ?? false,
    parent: options.parent ?? undefined,
  };
}

export function resolve(subscriptions, settings) {
  try {
    return resolveTiers(subscriptions, settings);
  } catch (error) {
    throw new CliError(error.message, 2);
  }
}

export const userBans = (config) => (isSupportedSchema(config)
  ? union(config.userBannedModels ?? [], config.bannedModels ?? [])
  : (config?.bannedModels ?? []).filter((entry) => !OLD_DEFAULT_BANS.includes(entry.trim().toLowerCase())));

/** A subscription config for the request. An unchanged selection keeps the existing ladders and models. */
export function subscriptionConfig(existing, { subscriptions, allowUsageCredits, parent }) {
  const claude = CATALOG.claude[subscriptions.claude];
  const previous = existing?.parent?.model;
  const keepParent = claude?.parentOptions?.includes(previous) && (!claude.usageBilled || allowUsageCredits);
  const resolved = resolve(subscriptions, { parent: parent ?? (keepParent ? previous : undefined), allowUsageCredits });
  if (isSupportedSchema(existing) && isDeepStrictEqual(subscriptions, existing.subscriptions)
    && allowUsageCredits === (existing.allowUsageCredits ?? false)) {
    return { ...existing, ...(parent && parent !== previous && { parent: resolved.parent }) };
  }
  const config = toConfig(resolved, {
    allowUsageCredits,
    allowFastModes: existing?.allowFastModes,
    verifiedOrg: existing?.verifiedOrg,
    userBannedModels: userBans(existing),
    compactionThreshold: existing?.compactionThreshold,
  });
  for (const key of ['defaultEffort', 'modelIds', 'discovery', 'quota']) {
    if (existing?.[key] !== undefined) config[key] = existing[key];
  }
  return config;
}

/** Existing user config is the base; explicit flags override it. */
export function planConfig(file, options) {
  let existing = null;
  let invalid = false;
  if (fs.existsSync(file)) {
    try {
      existing = readJson(file);
      invalid = !isObject(existing) || configProblem(completeConfig(existing)) !== null;
    } catch {
      invalid = true;
    }
    if (invalid && !options.force) {
      const reason = isObject(existing) ? configProblem(completeConfig(existing)) : 'not a JSON object';
      throw new CliError(`${file}: ${reason}. Fix it, or use --force to back it up and replace it`);
    }
    if (invalid) existing = null;
  }

  const request = tierRequest(existing, options);
  let config = request ? subscriptionConfig(existing, request)
    : existing ? { ...existing } : loadPreset(options.preset ?? PRESETS[0]);
  // A rebuilt roster replaces the user's ladders, so it is always backed up.
  const rebuilt = Boolean(request && existing) && !isDeepStrictEqual(config.ladders, existing.ladders);
  if (!isSupportedSchema(config) && existing && options.preset && options.preset !== existing.preset) {
    const preset = loadPreset(options.preset);
    config = {
      ...preset,
      ...existing,
      preset: preset.preset,
      allowlist: preset.allowlist,
      ladders: preset.ladders,
      defaultModel: preset.defaultModel,
      defaultEffort: preset.defaultEffort,
      bannedModels: union(existing.bannedModels ?? [], preset.bannedModels),
    };
  }
  if (options.compaction !== undefined) config.compactionThreshold = options.compaction;
  if (options.banned?.length) {
    config.bannedModels = union(completeConfig(config).bannedModels, options.banned);
    if (isSupportedSchema(config)) config.userBannedModels = union(config.userBannedModels ?? [], options.banned);
  }
  if (isSupportedSchema(config)) {
    for (const key of ['allowFastModes', 'verifiedOrg']) if (options[key] !== undefined) config[key] = options[key];
  }
  for (const [name, tier] of Object.entries(isSupportedSchema(config) ? {} : options.tiers ?? {})) {
    const old = config.tiers?.[name];
    config.tiers = { ...config.tiers, [name]: { ...old, ...tier, heavyModels: old?.heavyModels ?? tier.heavyModels } };
  }

  const complete = completeConfig(config);
  const problem = configProblem(complete);
  if (problem) throw new CliError(`${file}: ${problem}`);
  const changed = !existing || !isDeepStrictEqual(config, existing);
  const text = changed ? `${JSON.stringify(config, null, 2)}\n` : null;
  return { complete, invalid, rebuilt, selected: Boolean(request), text };
}

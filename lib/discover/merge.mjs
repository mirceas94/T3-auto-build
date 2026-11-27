// Model drift, lock rechecks and the check-models orchestration. Node >=18, node:* only.
import path from 'node:path';
import {
  COOLDOWN_FILE, canonicalProvider, exactProvider, inferProvider, isBanned, isObject, isPlanRestricted, matchRetired,
  restrictedBy, warn,
} from '../../hooks/_shared.mjs';
import { isLocked, prune, readCooldowns, RECHECK_AFTER, withRecheck, writeCooldowns } from '../../hooks/_quota.mjs';
import { cheapestModel, supersedes } from '../plans.mjs';
import { PROBES, probeModels } from '../probe.mjs';
import { CACHE_TTL, STATUSES, put, readAvailabilityFile, unexpired, writeAvailability } from './cache.mjs';
import {
  DISCOVERED_ID, bannedTerms, configuredModels, discover, list, parseFamily, retiredPatterns, sameModel,
} from './sources.mjs';

/** Drops expired locks, adds new ones without ever shortening an existing lock, and stamps missing recheck times. */
function updateCooldowns(configDir, now, locks = []) {
  const file = path.join(configDir, COOLDOWN_FILE);
  let stored;
  try {
    stored = readCooldowns(file);
  } catch (error) {
    warn(`${COOLDOWN_FILE} left unchanged: it cannot be read (${error.code ?? error.name})`);
    return;
  }
  const { kept, removed } = prune(stored, now);
  let added = 0;
  for (const { key, entry } of locks) {
    if (Date.parse(kept[key]?.until) >= Date.parse(entry.until)) continue;
    kept[key] = entry;
    added += 1;
  }
  const unstamped = Object.values(kept).some((entry) => withRecheck(entry, now) !== entry);
  if (added || unstamped || Object.keys(removed).length > 0) {
    writeCooldowns(file, kept, { remove: Object.keys(removed), now });
  }
}

const isExcluded = (model, config) => matchRetired(model, retiredPatterns(config)) || isBanned(model, bannedTerms(config));

/** "plan-restricted" or "unavailable" when the config or a live availability entry blocks the model, else null. */
function restriction(config, availability, provider, model, now) {
  if (isPlanRestricted(list(config?.planRestrictedModels), provider, model, config)) return 'plan-restricted';
  return restrictedBy(availability, provider, model, now, config)?.status ?? null;
}

/** The stored locks, or {} when the file cannot be read (updateCooldowns has already warned). */
function storedCooldowns(configDir) {
  try {
    return readCooldowns(path.join(configDir, COOLDOWN_FILE), () => {});
  } catch {
    return {};
  }
}

/**
 * Tests provider locks that are due (all of them when force is set) against the cheapest standard model. Without a
 * probeable local CLI the lock is left for the orchestrator ("via-t3"). Model and pool locks are not rechecked: a
 * cheap standard model proves nothing about them.
 */
async function recheckLocks({ configDir, config, binaries, force, now, runner, which, probe }) {
  const outcomes = [];
  for (const [key, entry] of Object.entries(storedCooldowns(configDir))) {
    const provider = entry.scope === 'provider' ? exactProvider(key.replace(/^provider:/i, '')) : null;
    if (!provider || !(Date.parse(entry.until) > now)) continue;
    if (!force && !(Date.parse(entry.recheckAfter) <= now)) continue;
    const availability = readAvailabilityFile(configDir);
    // A model under its own model or pool lock is no test of the provider, and the hook would block its canary.
    const narrower = Object.fromEntries(Object.entries(storedCooldowns(configDir))
      .filter(([, other]) => other.scope !== 'provider'));
    const model = cheapestModel(provider, configuredModels(config)
      .filter((item) => item.provider === provider && !item.scarceQuota && !isExcluded(item.model, config)
        && !restriction(config, availability, provider, item.model, now)
        && !isLocked(narrower, { provider, model: item.model, config }, now))
      .map((item) => item.model));
    if (!model) continue;
    if (!binaries[provider]?.found || !Object.hasOwn(PROBES, provider)) {
      outcomes.push({ key, provider, model, result: 'via-t3' });
      continue;
    }
    const { results } = await probe({ config, candidates: { [provider]: [model] }, runner, which, now });
    const cleared = results[0]?.state === 'available';
    // Read again: a lock replaced while the probe ran is left alone.
    const current = storedCooldowns(configDir);
    if (current[key]?.until !== entry.until) continue;
    if (cleared) delete current[key];
    else current[key] = { ...current[key], recheckAfter: new Date(now + RECHECK_AFTER).toISOString() };
    writeCooldowns(path.join(configDir, COOLDOWN_FILE), current, { remove: cleared ? [key] : [], now });
    outcomes.push({ key, provider, model, result: cleared ? 'cleared' : 'still-locked' });
  }
  return outcomes;
}

/** One status per configured model; a model nothing speaks against counts as available. */
function modelStatuses({ configDir, config, availability, results, probeScarce, now }) {
  const cooldowns = storedCooldowns(configDir);
  return configuredModels(config).map(({ provider, model, scarceQuota }) => {
    const ref = `${provider}:${model}`;
    const result = results.find((r) => canonicalProvider(r.provider) === provider && r.model === model);
    // A failed probe (no CLI, logged out, timeout) blocks nothing, so it never reports "unavailable".
    const cached = availability.models[ref]?.status;
    const status = restriction(config, availability, provider, model, now)
      || (isExcluded(model, config) && 'unavailable')
      || (isLocked(cooldowns, { provider, model, config }, now) && 'rate-limited')
      || (result?.state === 'rate-limited' && 'rate-limited')
      || (STATUSES.includes(cached) && cached)
      || (scarceQuota && !probeScarce ? 'skipped-scarce' : 'available');
    return { ref, status };
  });
}

/** Configured models worth spending a probe on, grouped by provider, and the scarce ones left out. */
function probeCandidates(config, probeScarce, cooldowns, now) {
  const candidates = {};
  const skippedScarce = [];
  for (const { provider, model, scarceQuota } of configuredModels(config)) {
    // A locked model is left to recheckLocks: probing it again would spend quota and could extend the lock.
    if (isExcluded(model, config) || isLocked(cooldowns, { provider, model, config }, now)) continue;
    if (scarceQuota && !probeScarce) skippedScarce.push(`${provider}:${model}`);
    else (candidates[provider] ??= []).push(model);
  }
  return { candidates, skippedScarce };
}

/**
 * Prunes expired state, runs discovery, probes only when the cache is stale or refresh is set, and saves the result.
 * checkedAt dates the last probe run, so discovery alone never keeps the cache fresh.
 */
export async function checkModels({
  configDir, config, refresh = false, probeScarce = false, recheckLocks: force = false, ttlMs = CACHE_TTL,
  now = Date.now(), runner, which, probe = probeModels,
} = {}) {
  updateCooldowns(configDir, now);
  const found = await discover({ config, runner, which, now });
  const rechecked = await recheckLocks({
    configDir, config, binaries: found.binaries, force, now, runner, which, probe,
  });
  const checkedAt = readAvailabilityFile(configDir)?.checkedAt;
  const stale = !(now - Date.parse(checkedAt) < ttlMs);
  const probing = stale || refresh;
  let results = [];
  let skippedScarce = [];
  if (probing) {
    const selected = probeCandidates(config, probeScarce, storedCooldowns(configDir), now);
    skippedScarce = selected.skippedScarce;
    ({ results } = await probe({
      config, candidates: selected.candidates, probeScarce, runner, which, now,
    }));
    updateCooldowns(configDir, now, results.filter((r) => r.cooldown).map((r) => r.cooldown));
  }

  // Read again: a mark may have been written while the probes ran.
  const models = unexpired(readAvailabilityFile(configDir)?.models, now);
  const stamp = new Date(now).toISOString();
  for (const [ref, entry] of Object.entries(found.models)) {
    const [, provider, model] = ref.match(/^([^:]+):(.+)$/);
    put(models, provider, model, entry, now);
  }
  for (const { provider, model, state, skipped } of results) {
    // "unavailable" also means timeout, logged out or unprobeable, so it must not block the model.
    if (skipped || !['available', 'plan-restricted'].includes(state)) continue;
    put(models, canonicalProvider(provider), model, { status: state, source: 'probe', checkedAt: stamp }, now);
  }
  const availability = writeAvailability(configDir, {
    checkedAt: probing ? stamp : checkedAt,
    ttlMs,
    binaries: found.binaries,
    models,
    discoveredNew: found.discoveredNew,
    missingConfigured: found.missingConfigured,
  });
  const probed = results.filter((r) => !r.skipped).map((r) => `${canonicalProvider(r.provider)}:${r.model}`);
  const statuses = modelStatuses({ configDir, config, availability, results, probeScarce, now });
  return { availability, probed, skippedScarce, stale, statuses, rechecked };
}

/**
 * A copy of config with every superseded model replaced by its newest discovered successor, for that hosting only.
 * The availability data is re-checked here: only a newer version of a configured family is ever promoted.
 */
export function applyDrift(config, availability) {
  const next = structuredClone(config);
  const drift = (Array.isArray(availability?.discoveredNew) ? availability.discoveredNew : []).filter(isObject);
  const configured = configuredModels(config);
  const restricted = list(config?.planRestrictedModels);
  const best = new Map();
  for (const { provider: host, model, supersedes: old } of drift) {
    const provider = canonicalProvider(host);
    if (typeof old !== 'string' || typeof model !== 'string' || !DISCOVERED_ID.test(model)) continue;
    const mine = configured.filter((entry) => entry.provider === provider);
    const from = mine.find((entry) => sameModel(entry.model, old, config));
    const parsed = parseFamily(model);
    if (!from || !parsed || !supersedes(parsed, parseFamily(from.model) ?? {})) continue;
    if (matchRetired(model, retiredPatterns(config)) || isBanned(model, bannedTerms(config))) continue;
    if (isPlanRestricted(restricted, provider, model, config)) continue;
    if (mine.some((entry) => sameModel(entry.model, model, config))) continue;
    const key = `${provider}:${from.model}`;
    const current = best.get(key);
    if (!current || supersedes(parsed, current.parsed)) best.set(key, { provider, from: from.model, to: model, parsed });
  }

  for (const { provider, from, to, parsed } of best.values()) {
    const isOld = (name) => typeof name === 'string' && sameModel(name, from, config);
    next.models = next.models.map((entry) => (canonicalProvider(entry?.provider) === provider && isOld(entry.model)
      ? { ...entry, model: to, ...parsed } : entry));
    for (const [group, names] of Object.entries(next.allowlist ?? {})) {
      if (canonicalProvider(group) !== provider || !Array.isArray(names)) continue;
      next.allowlist[group] = [...new Set(names.map((name) => (isOld(name) ? to : name)))];
    }
    for (const [slot, entries] of Object.entries(next.ladders ?? {})) {
      if (!Array.isArray(entries)) continue;
      next.ladders[slot] = entries.map((ref) => {
        // [provider:]model[@effort]; a bare model means its native provider.
        const parts = typeof ref === 'string' ? ref.match(/^(\s*(?:([^:@]+):)?\s*)([^@]*?)(\s*(?:@.*)?)$/) : null;
        if (!parts) return ref;
        const [, head, prefix, name, tail] = parts;
        const hosting = prefix === undefined ? inferProvider(name) : canonicalProvider(prefix);
        return hosting === provider && isOld(name) ? `${head}${to}${tail}` : ref;
      });
    }
    if (inferProvider(from) === provider && isOld(next.defaultModel)) next.defaultModel = to;
  }
  return {
    config: next,
    promoted: [...best.values()].map(({ provider, from, to }) => ({ provider, from, to })),
    unknown: drift.filter((entry) => !entry.supersedes),
  };
}

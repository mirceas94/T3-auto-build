// Manual cooldown locks and live quota checks behind `t3-auto-build quota`. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import {
  COOLDOWN_FILE, QUOTA_DEFAULTS, canonicalProvider, cliModelId, exactProvider, inferProvider, isSupportedSchema,
  loadConfig, lockError, modelKeys, normalizeModel, removeFile, resolveTarget, which as findOnPath, withFileLock,
} from '../hooks/_shared.mjs';
import { isLocked, parseRateLimit, prune, readCooldowns, SCARCE_POOL, updateCooldowns } from '../hooks/_quota.mjs';
import { HEAVY_MODELS } from './detect.mjs';
import { POOLS } from './plans.mjs';
import { CliError } from './paths.mjs';
import { applicableWindows, refreshQuota } from './quota/usage.mjs';

export const QUOTA_WINDOWS = ['burst', '5h', 'weekly'];
const isProvider = (name) => Object.hasOwn(HEAVY_MODELS, name);
const cooldownPath = (target) => path.join(target, COOLDOWN_FILE);
// File and argument text is printed, so it is kept to one line without control characters.
const clean = (text) => String(text).replace(/[\s\p{Cc}]+/gu, ' ').slice(0, 120);

function load(target, onInvalid) {
  const file = cooldownPath(target);
  try {
    return readCooldowns(file, onInvalid);
  } catch (error) {
    // The parser message can quote file content, so only the error name is shown.
    throw new CliError(`${file}: cannot be read (${error.code ?? error.name}); fix it or run quota clear --all`);
  }
}

function mutate(target, updater, options = {}) {
  const file = cooldownPath(target);
  try {
    return updateCooldowns(file, updater, options);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === 'ELOCKED') throw new CliError(`${file}: busy (${error.message})`);
    throw new CliError(`${file}: cannot be read (${error.code ?? error.name}); fix it or run quota clear --all`);
  }
}

/** { provider } for a provider name, else { model, id } for a model this config or a known family names. */
function resolveSubject(subject, config) {
  const text = String(subject ?? '').trim();
  const lower = text.toLowerCase();
  const qualified = text.match(/^([^:]+):([^:]+)$/);
  if (qualified) {
    const provider = canonicalProvider(qualified[1]);
    if (!provider) throw new CliError(`unknown provider "${clean(qualified[1])}"`, 2);
    const model = normalizeModel(qualified[2].split('@')[0].trim());
    if (!model) throw new CliError(`unknown provider or model "${clean(text)}"`, 2);
    return { provider, model, id: cliModelId(provider, model, config), qualified: true };
  }
  const canonical = canonicalProvider(lower);
  if (canonical && !inferProvider(text)) return { provider: canonical };
  const model = normalizeModel(text.split('@')[0].trim());
  const wanted = modelKeys(model, config);
  const known = [...Object.values(config.allowlist).flat(), ...Object.keys(config.modelIds ?? {})]
    .some((name) => [...modelKeys(name, config)].some((key) => wanted.has(key)));
  if (!model || (!known && !inferProvider(model))) {
    throw new CliError(`unknown provider or model "${clean(text)}"; use ${Object.keys(HEAVY_MODELS).join(', ')} or a model name`, 2);
  }
  return { model, id: cliModelId(inferProvider(model), model, config), qualified: false };
}

function poolName(pool) {
  const value = String(pool ?? '').trim().toLowerCase();
  if (!value || (!POOLS.includes(value) && !/^[a-z0-9-]+$/.test(value))) {
    throw new CliError(`invalid pool "${clean(pool)}"; use a pool name containing lowercase letters, digits or hyphens`, 2);
  }
  return value;
}

const UNIT_MS = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO time, or a duration such as 90m or 1w2d, as a future timestamp. */
function parseUntil(value, now) {
  const text = String(value).trim();
  let time = NaN;
  if (/^(\d+[wdhm])+$/.test(text)) {
    time = [...text.matchAll(/(\d+)([wdhm])/g)].reduce((total, [, n, unit]) => total + n * UNIT_MS[unit], now);
  } else {
    const [, year, month, day] = text.match(ISO) ?? [];
    // Date.parse rolls 02-30 over into March, so the calendar date is checked separately.
    if (year && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === Number(day)) time = Date.parse(text);
  }
  if (!(time > now && time < 8.64e15)) {
    throw new CliError(`invalid --until "${clean(text)}"; use a future ISO time or a duration such as 90m, 5h or 1w2d`, 2);
  }
  return time;
}

/** Locks a provider or model for a window (default burst) or until a given time. */
export function quotaSet(target, subject, { window, until, reason, pool, heavy = false, now = Date.now(), log = console.log } = {}) {
  if (window !== undefined && until !== undefined) throw new CliError('give a window or --until, not both', 2);
  if (pool !== undefined && heavy) throw new CliError('give --pool or --heavy, not both', 2);
  const span = until === undefined ? window ?? 'burst' : 'custom';
  if (span !== 'custom' && !QUOTA_WINDOWS.includes(span)) throw new CliError(`unknown window "${clean(span)}"`, 2);
  const config = loadConfig(target);
  const targetRef = resolveSubject(subject, config);
  const { provider, id, model } = targetRef;
  const host = provider ?? resolveTarget({ model }, config).provider;
  if ((pool !== undefined || heavy) && !host) throw new CliError(`cannot determine provider for "${clean(subject)}"`, 2);
  const tier = config.tiers?.[host];
  const limit = span === 'custom'
    ? { until: new Date(parseUntil(until, now)).toISOString() }
    : parseRateLimit({ burst: '', '5h': '5h limit', weekly: 'weekly limit' }[span], {
      now, sharing: tier?.sharing, resetDay: tier?.resetDay,
    });
  let scope = provider && !model ? 'provider' : 'model';
  let poolKey;
  if (pool !== undefined) {
    scope = 'tier';
    poolKey = poolName(pool);
  } else if (heavy) {
    scope = 'tier';
    poolKey = SCARCE_POOL[host] ?? 'heavy';
  } else if (provider && !model && span === '5h' && limit.scope === 'tier') {
    scope = 'tier';
    poolKey = isSupportedSchema(config) ? (SCARCE_POOL[host] ?? 'heavy') : 'heavy';
  }
  const key = scope === 'tier' ? `tier:${host}:${poolKey}`
    : scope === 'provider' ? `provider:${provider}`
      : targetRef.qualified ? `model:${provider}:${id}` : `model:${id}`;
  const entry = {
    scope, window: span, until: limit.until, reason: reason ?? `manual lock (${span})`, source: 'manual',
    ...(scope === 'tier' && { tier: poolKey }),
  };
  mutate(target, (current) => ({ data: { ...prune(current, now).kept, [key]: entry } }), { now });
  log(`locked ${key} until ${entry.until} (${span})`);
  return { key, entry };
}

export function countdown(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return '0s';
  let seconds = Math.ceil(ms / 1000);
  const parts = [];
  for (const [unit, size] of [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const count = Math.floor(seconds / size);
    seconds -= count * size;
    if (count || parts.length) parts.push(`${count}${unit}`);
  }
  return parts.join(' ');
}

/** Drops expired locks and prints the rest. Returns the active ones. */
export function quotaStatus(target, { now = Date.now(), log = console.log } = {}) {
  let { kept, removed } = prune(load(target), now);
  if (Object.keys(removed).length) {
    mutate(target, (current) => {
      const split = prune(current, now);
      kept = split.kept;
      return Object.keys(split.removed).length ? { data: split.kept } : null;
    }, { now, onInvalid: () => {} });
  }
  const locks = Object.entries(kept).map(([key, entry]) => ({ key, ...entry }));
  if (!locks.length) log('no active cooldowns');
  for (const { key, window, until, reason, source } of locks) {
    log(`${clean(key)}: ${countdown(Date.parse(until) - now)} left, resets ${until} `
      + `(${clean(window)}, ${clean(source)}: ${clean(reason)})`);
  }
  return locks;
}

/** Removes a regular cooldown file without following a symlink or junction. */
function unlinkRegular(file) {
  let stat;
  try {
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch (error) {
    throw new CliError(`${file}: cannot be cleared (${error.code ?? error.name})`);
  }
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CliError(`${file}: refusing to remove ${stat.isSymbolicLink() ? 'symlink' : 'non-regular file'}`);
  }
  try {
    removeFile(file);
  } catch (error) {
    throw new CliError(`${file}: cannot be cleared (${error.code ?? error.name})`);
  }
}

/** True when `p` exists (without following symlinks/junctions) and is not a regular file. */
function isNonRegular(p) {
  try {
    const stat = fs.lstatSync(p, { throwIfNoEntry: false });
    return Boolean(stat && !stat.isFile());
  } catch {
    return false;
  }
}

/** Removes an empty leftover lock directory without following symlinks/junctions or touching contents. Returns true if removed. */
function removeEmptyDir(dir) {
  try {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isDirectory()) {
      fs.rmdirSync(dir);
      return true;
    }
  } catch {
    // non-empty, symlink/junction, or busy: leave unrelated entries untouched
  }
  return false;
}

/** Removes a regular lock file (without following symlinks or deleting dirs) so an active holder's stillHeld() fails. */
function invalidateRegularLock(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isFile()) {
      removeFile(lockPath);
      return true;
    }
  } catch {
    // leave non-regular or busy entries untouched
  }
  return false;
}

/** subject: a provider or model name, or { all: true }. Returns the removed keys (null for all). */
export function quotaClear(target, subject, { log = console.log, timeoutMs } = {}) {
  const file = cooldownPath(target);
  if (subject?.all) {
    if (fs.existsSync(path.dirname(file))) {
      const lockOpts = timeoutMs === undefined ? undefined : { timeoutMs };
      const lockPath = `${file}.lock`;
      const guardPath = `${lockPath}.guard`;
      const clearUnderLock = () => withFileLock(file, (stillHeld) => {
        if (!stillHeld()) throw lockError(`lost lock ${path.basename(file)}.lock before clear`);
        unlinkRegular(file);
      }, lockOpts);
      const clearUnlocked = (reason) => {
        // shortcut: a holder between its stillHeld() check and renameSync can still land one stale write after invalidation
        const invalidated = invalidateRegularLock(lockPath);
        log(`warning: ${file}: ${reason}; ${invalidated ? 'invalidated lock and clearing without lock' : 'clearing without lock'}`);
        unlinkRegular(file);
      };
      try {
        clearUnderLock(); // also the way out of a corrupt file
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (error?.code !== 'ELOCKED') throw new CliError(`${file}: cannot be cleared (${error.code ?? error.name})`);
        const clearedLock = removeEmptyDir(lockPath);
        const clearedGuard = removeEmptyDir(guardPath);
        if (isNonRegular(lockPath) || isNonRegular(guardPath)) {
          clearUnlocked(error.message);
        } else if (clearedLock || clearedGuard) {
          log(`warning: ${file}: ${error.message}; retrying after clearing empty lock directory`);
          try {
            clearUnderLock();
          } catch (retryError) {
            if (retryError instanceof CliError) throw retryError;
            if (retryError?.code === 'ELOCKED') {
              clearUnlocked(retryError.message);
            } else {
              throw new CliError(`${file}: cannot be cleared (${retryError.code ?? retryError.name})`);
            }
          }
        } else {
          clearUnlocked(error.message);
        }
      }
    }
    log('cleared all cooldowns');
    return null;
  }
  const config = loadConfig(target);
  // "provider:<p>" is the lock key as quota status prints it.
  const named = String(subject ?? '').trim().replace(/^provider:/i, '');
  const targetRef = resolveSubject(exactProvider(named) ? named : subject, config);
  const { provider, model, qualified } = targetRef;
  let removed = [];
  if (fs.existsSync(file)) {
    const bad = [];
    mutate(target, (data) => {
      // A malformed entry has no usable fields, so it is matched by its key alone.
      const stubs = bad.map((key) => [key, {
        scope: key.match(/^(model|provider|tier):/i)?.[1].toLowerCase() ?? (provider && !model ? 'provider' : 'model'),
        until: '9999-01-01T00:00:00Z',
      }]);
      removed = [...Object.entries(data), ...stubs].filter(([key, entry]) => {
        if (provider && !model && entry.scope === 'tier') {
          const host = key.match(/^tier:([^:]+):/i)?.[1];
          return exactProvider(host ?? '') === provider;
        }
        if (provider && !model && entry.scope === 'provider') return exactProvider(key.replace(/^provider:/i, '')) === provider;
        if (model && entry.scope === 'tier') return false;
        if (model && entry.scope === 'model' && qualified) {
          const wanted = modelKeys(model, config);
          const prefixed = key.match(/^model:([^:]+):(.+)$/i);
          if (prefixed) {
            return exactProvider(prefixed[1]) === provider
              && [...modelKeys(prefixed[2], config)].some((k) => wanted.has(k));
          }
          return [...modelKeys(key.replace(/^model:/i, ''), config)].some((k) => wanted.has(k));
        }
        // Time 0 makes isLocked match expired entries too.
        return entry.scope === (provider && !model ? 'provider' : 'model')
          && isLocked({ [key]: entry }, { provider, model, config }, 0) !== null;
      }).map(([key]) => key);
      if (!removed.length) return null;
      for (const key of removed) delete data[key];
      return { data, remove: removed };
    }, { onInvalid: (key) => bad.push(key) });
  }
  log(removed.length ? `cleared: ${removed.map(clean).join(', ')}` : `no cooldown recorded for ${clean(subject)}`);
  return removed;
}

const SHORT_RESET_MS = 120_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks live provider quota usage, updates auto-build-quota.json, and writes threshold auto-locks.
 * Default return is the map of recorded locks; with onError=true returns { locks, windows, action, waitedMs }.
 */
export async function quotaCheck(target, {
  providers, subject, refresh = false, onError = false, claudeUsage, runner, rpcRunner,
  which = findOnPath, now = Date.now(), sleep = defaultSleep, log = console.log, timeoutMs = 15_000,
} = {}) {
  const config = loadConfig(target);
  let targetProvider = null;
  let targetPool = 'standard';
  let names;

  if (subject !== undefined) {
    const ref = resolveSubject(subject, config);
    if (ref.model) {
      const resolved = resolveTarget({ providers: ref.provider ? [ref.provider] : [], model: ref.model }, config);
      targetProvider = resolved.provider;
      targetPool = resolved.pool;
    } else {
      targetProvider = ref.provider;
    }
    if (!targetProvider) throw new CliError(`cannot determine provider for "${clean(subject)}"`, 2);
    names = providers?.length ? providers.map((p) => p.toLowerCase()) : [targetProvider];
  } else {
    names = providers?.length ? providers.map((p) => p.toLowerCase()) : Object.keys(HEAVY_MODELS);
  }

  const unknown = names.find((name) => !isProvider(name));
  if (unknown !== undefined) throw new CliError(`unknown provider "${clean(unknown)}"; use ${Object.keys(HEAVY_MODELS).join(', ')}`, 2);

  const quotaCfg = config.quota ?? {};
  const minRemainingPct = quotaCfg.minRemainingPct ?? QUOTA_DEFAULTS.minRemainingPct;
  const burstLockMs = quotaCfg.burstLockMs ?? QUOTA_DEFAULTS.burstLockMs;
  const effectiveClaude = claudeUsage ?? quotaCfg.claudeUsage ?? QUOTA_DEFAULTS.claudeUsage;

  const result = await refreshQuota(target, {
    providers: names,
    runner,
    rpcRunner,
    which,
    claudeUsage: effectiveClaude,
    refresh: Boolean(refresh || onError),
    now,
    timeoutMs,
    minRemainingPct,
  });

  const locks = { ...result.locks };
  for (const provider of names) {
    const entry = result.providers[provider];
    if (entry?.status === 'ok' && entry.windows.length) {
      const summary = entry.windows.map((w) => {
        const span = w.windowMinutes >= 10_080 ? `${Math.round(w.windowMinutes / 1440)}d` : `${Math.round(w.windowMinutes / 60)}h`;
        const reset = w.resetsAt ? ` resets ${w.resetsAt}` : '';
        return `${w.pool}/${span} ${w.remainingPct}% left${reset}`;
      }).join(', ');
      log(`${provider}: ${summary}`);
    } else {
      log(`${provider}: quota unknown; using recorded cooldowns`);
    }
  }
  for (const [key, entry] of Object.entries(locks)) {
    log(`${key}: locked until ${entry.until} (${entry.reason})`);
  }

  if (!onError) return locks;

  const subjProvider = targetProvider ?? names[0];
  const subjPool = targetPool ?? 'standard';
  const applicable = applicableWindows(result.windows, subjProvider, subjPool);
  const exhausted = applicable.filter((w) => {
    if (!(w.remainingPct <= minRemainingPct)) return false;
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return resetMs > now;
  });

  if (exhausted.length > 0) {
    const resetDeltas = exhausted.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) - now : NaN));
    const allShort = resetDeltas.every((delta) => delta > 0 && delta < SHORT_RESET_MS);
    if (allShort) {
      const waitedMs = Math.max(...resetDeltas);
      await sleep(waitedMs);
      const afterNow = now + waitedMs;
      try {
        mutate(target, (current) => {
          const split = prune(current, afterNow);
          return Object.keys(split.removed).length ? { data: split.kept } : null;
        }, { now: afterNow, onInvalid: () => {} });
      } catch (error) {
        log(`warning: failed to prune expired cooldowns: ${error.message}`);
      }
      for (const [key, entry] of Object.entries(locks)) {
        if (Date.parse(entry.until) <= afterNow) delete locks[key];
      }
      log(`${subjProvider}: waited ${countdown(waitedMs)} for reset; retry once`);
      return { locks, windows: result.windows, action: 'retry', waitedMs };
    }
    return { locks, windows: result.windows, action: 'failover', waitedMs: 0 };
  }

  const burstKey = `tier:${subjProvider}:${subjPool}`;
  if (!(burstLockMs > 0)) {
    log(`${burstKey}: burst lock disabled (burstLockMs=0); skipping write`);
    return { locks, windows: result.windows, action: 'failover', waitedMs: 0 };
  }
  const burstEntry = {
    scope: 'tier',
    tier: subjPool,
    window: 'burst',
    until: new Date(now + burstLockMs).toISOString(),
    reason: 'quota error burst lock',
    source: 'quota',
  };
  try {
    let recorded = burstEntry;
    mutate(target, (stored) => {
      if (Date.parse(stored[burstKey]?.until) >= Date.parse(burstEntry.until)) {
        recorded = stored[burstKey];
        return null;
      }
      return { data: { ...stored, [burstKey]: burstEntry } };
    }, { now });
    locks[burstKey] = recorded;
    log(`${burstKey}: burst locked until ${recorded.until}`);
  } catch (error) {
    log(`warning: burst lockout not recorded: ${error.message}`);
  }
  return { locks, windows: result.windows, action: 'failover', waitedMs: 0 };
}

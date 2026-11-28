// Live provider quota readers, cache, pool mapping, threshold auto-locks, and pace scoring. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import {
  COOLDOWN_FILE, PROVIDERS, QUOTA_DEFAULTS, QUOTA_FILE, SCARCE_POOL, canonicalProvider, isObject, loadConfig,
  lockError, readJson, warn, which as findOnPath, withFileLock, writeFileAtomic,
} from '../../hooks/_shared.mjs';
import { MAX_LOCK, updateCooldowns } from '../../hooks/_quota.mjs';
import { asyncRunner, rpcRunner as createRpcRunner } from '../discover/sources.mjs';

export const QUOTA_TTL_MS = QUOTA_DEFAULTS.ttlMs;
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const CLIENT_INFO = Object.freeze({ name: 't3-auto-build', version: '3.0.0' });
const UNKNOWN = Object.freeze({ status: 'unknown', windows: Object.freeze([]) });

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const quotaReadersDisabled = () => /^(0|off|false)$/i.test(String(process.env.T3AB_QUOTA_READERS ?? '').trim());
// Strips CSI, OSC, and 2-byte ANSI escape sequences.
const stripAnsi = (text) => String(text ?? '').replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');

/** Allowlisted window shape only (never retains account ids, emails, or plan metadata). */
export function sanitizeWindow(entry) {
  if (!isObject(entry)) return null;
  const provider = canonicalProvider(entry.provider);
  const pool = typeof entry.pool === 'string' && /^[a-z0-9-]+$/i.test(entry.pool) ? entry.pool.toLowerCase() : null;
  const roundedMinutes = typeof entry.windowMinutes === 'number' && Number.isFinite(entry.windowMinutes)
    ? Math.round(entry.windowMinutes) : NaN;
  const windowMinutes = roundedMinutes >= 1 ? roundedMinutes : null;
  const remainingPct = typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct)
    ? clamp(entry.remainingPct, 0, 100) : null;
  let resetsAt = null;
  if (entry.resetsAt !== null && entry.resetsAt !== undefined) {
    const parsed = typeof entry.resetsAt === 'string' ? Date.parse(entry.resetsAt) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    resetsAt = new Date(parsed).toISOString();
  }
  if (!provider || !pool || windowMinutes === null || remainingPct === null) return null;
  return { provider, pool, windowMinutes, remainingPct, resetsAt };
}

/** Parses Codex `account/rateLimits/read` result into allowlisted windows. Never keeps accountId. */
export function parseCodexRateLimits(result) {
  if (!isObject(result)) return [];
  const buckets = isObject(result.rateLimitsByLimitId)
    ? Object.entries(result.rateLimitsByLimitId)
    : isObject(result.rateLimits) ? [['standard', result.rateLimits]] : [];
  const windows = [];
  for (const [limitId, bucket] of buckets) {
    if (!isObject(bucket)) continue;
    const pool = /astra/i.test(limitId) ? SCARCE_POOL.codex : 'standard';
    for (const slot of ['primary', 'secondary']) {
      const win = bucket[slot];
      if (!isObject(win)) continue;
      const used = typeof win.usedPercent === 'number' ? win.usedPercent : NaN;
      const mins = typeof win.windowDurationMins === 'number' ? win.windowDurationMins : NaN;
      if (!Number.isFinite(used) || !Number.isFinite(mins) || mins <= 0) continue;
      let resetsAt = null;
      if (win.resetsAt !== null && win.resetsAt !== undefined) {
        const secs = typeof win.resetsAt === 'number' ? win.resetsAt : NaN;
        if (Number.isFinite(secs) && secs > 0) resetsAt = new Date(secs * 1000).toISOString();
      }
      const clean = sanitizeWindow({
        provider: 'codex',
        pool,
        windowMinutes: mins,
        remainingPct: clamp(100 - used, 0, 100),
        resetsAt,
      });
      if (clean) windows.push(clean);
    }
  }
  return windows;
}

/** Parses Antigravity `agy -p /usage` TSV output. Reset <= epoch 0 means not started (100%, null). */
export function parseAntigravityUsage(text) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const windows = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.includes('\t')) continue;
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 4) continue;
    const [poolLabel, windowLabel, pctText, resetText] = cols;
    let pool = null;
    if (/claude|gpt/i.test(poolLabel)) pool = SCARCE_POOL.antigravity;
    else if (/gemini/i.test(poolLabel)) pool = 'standard';
    if (!pool) continue;

    let windowMinutes = null;
    if (/weekly/i.test(windowLabel)) windowMinutes = 10_080;
    else if (/five\s*hour|5\s*h/i.test(windowLabel)) windowMinutes = 300;
    if (!windowMinutes) continue;

    const pctMatch = pctText.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (!pctMatch) continue;
    const resetMs = Date.parse(resetText);
    if (Number.isNaN(resetMs)) continue;

    const notStarted = resetMs <= 0;
    const clean = sanitizeWindow({
      provider: 'antigravity',
      pool,
      windowMinutes,
      remainingPct: notStarted ? 100 : clamp(Number(pctMatch[1]), 0, 100),
      resetsAt: notStarted ? null : new Date(resetMs).toISOString(),
    });
    if (clean) windows.push(clean);
  }
  return windows;
}

const MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

function partsInTz(epochMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  return map;
}

function zonedWallClockToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const p1 = partsInTz(guess, tz);
  const off1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second) - guess;
  const t1 = guess - off1;
  const p2 = partsInTz(t1, tz);
  const off2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second) - t1;
  return guess - off2;
}

function parseClaudeReset(resetStr, now) {
  const tzMatch = resetStr.match(/\(([^()]+)\)\s*$/);
  const tz = tzMatch ? tzMatch[1].trim() : 'UTC';
  const body = (tzMatch ? resetStr.slice(0, tzMatch.index) : resetStr).trim();
  let nowParts;
  try {
    nowParts = partsInTz(now, tz);
  } catch {
    return null;
  }
  const m = body.match(/^(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:,\s*|\s+)(?:at\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) return null;
  const [, monthName, dayStr, yearStr, hourStr, minStr, meridiem] = m;
  let hour = Number(hourStr);
  const minute = minStr ? Number(minStr) : 0;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  let ts;
  if (monthName) {
    const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
    const day = Number(dayStr);
    if (!month || day < 1 || day > 31) return null;
    const year = yearStr ? Number(yearStr) : nowParts.year;
    ts = zonedWallClockToUtc(year, month, day, hour, minute, tz);
    // Roll over year boundary when month/day without year lands well in the past (e.g. Dec 30 -> Jan 2).
    if (!yearStr && ts < now - 12 * 3_600_000) {
      ts = zonedWallClockToUtc(year + 1, month, day, hour, minute, tz);
    }
  } else {
    ts = zonedWallClockToUtc(nowParts.year, nowParts.month, nowParts.day, hour, minute, tz);
    if (ts <= now) {
      const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));
      ts = zonedWallClockToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, minute, tz);
    }
  }
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function classifyClaudeLabel(label) {
  if (/fable/i.test(label)) {
    return { pool: SCARCE_POOL.claude, windowMinutes: /session/i.test(label) ? 300 : 10_080 };
  }
  if (/session/i.test(label) && !/\(/.test(label)) {
    return { pool: 'standard', windowMinutes: 300 };
  }
  if (/week/i.test(label) && (!/\(/.test(label) || /all/i.test(label))) {
    return { pool: 'standard', windowMinutes: 10_080 };
  }
  return null;
}

/** Parses Claude `claude -p /usage` output. Any parse failure on an expected window line returns []. */
export function parseClaudeUsage(text, now = Date.now()) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const windows = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const label = line.slice(0, colonIdx).trim();
    const target = classifyClaudeLabel(label);
    if (!target) continue;
    const rest = line.slice(colonIdx + 1).trim();
    const match = rest.match(/^(\d+(?:\.\d+)?)\s*%\s*used\b.*?resets?\s+(.+?)\s*$/i);
    if (!match) return [];
    const [, usedStr, resetStr] = match;
    const resetsAt = parseClaudeReset(resetStr, now);
    if (!resetsAt) return [];
    const clean = sanitizeWindow({
      provider: 'claude',
      pool: target.pool,
      windowMinutes: target.windowMinutes,
      remainingPct: clamp(100 - Number(usedStr), 0, 100),
      resetsAt,
    });
    if (!clean) return [];
    windows.push(clean);
  }
  return windows;
}

/** Reads live quota for one provider. Always returns { status: 'ok'|'unknown', windows }. Never throws. */
export async function readProviderQuota(provider, {
  runner, rpcRunner, which, claudeUsage = false, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const canon = canonicalProvider(provider);
  if (!canon) return { status: 'unknown', windows: [] };

  try {
    if (canon === 'codex') {
      if (!rpcRunner && quotaReadersDisabled()) return { status: 'unknown', windows: [] };
      const rpc = rpcRunner ?? createRpcRunner(which ?? findOnPath);
      const outcome = await rpc('codex', ['app-server'], async ({ send, receive }) => {
        send({ id: 1, method: 'initialize', params: { clientInfo: CLIENT_INFO } });
        const initReply = await receive((msg) => msg?.id === 1);
        if (!initReply || initReply.error) return null;
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
        const reply = await receive((msg) => msg?.id === 2);
        return reply?.error ? null : (reply?.result ?? null);
      }, { timeout: timeoutMs });
      if (!outcome?.ok || !outcome.result) return { status: 'unknown', windows: [] };
      const windows = parseCodexRateLimits(outcome.result);
      return windows.length ? { status: 'ok', windows } : { status: 'unknown', windows: [] };
    }

    if (canon === 'antigravity') {
      if (!runner && quotaReadersDisabled()) return { status: 'unknown', windows: [] };
      const bin = which
        ? (which('agy') ?? which('antigravity') ?? (runner && which === findOnPath ? 'agy' : null))
        : (runner ? 'agy' : (findOnPath('agy') ?? findOnPath('antigravity')));
      if (!bin) return { status: 'unknown', windows: [] };
      const exec = runner ?? asyncRunner(which ?? findOnPath);
      const res = await exec(bin, ['-p', '/usage'], { timeout: timeoutMs });
      if (!res || res.error || res.status !== 0) return { status: 'unknown', windows: [] };
      const windows = parseAntigravityUsage(res.stdout ?? '');
      return windows.length ? { status: 'ok', windows } : { status: 'unknown', windows: [] };
    }

    if (canon === 'claude') {
      if (claudeUsage !== true || (!runner && quotaReadersDisabled())) return { status: 'unknown', windows: [] };
      const exec = runner ?? asyncRunner(which ?? findOnPath);
      const res = await exec('claude', ['-p', '/usage'], { timeout: timeoutMs });
      if (!res || res.error || res.status !== 0) return { status: 'unknown', windows: [] };
      const windows = parseClaudeUsage(res.stdout ?? '', now);
      return windows.length ? { status: 'ok', windows } : { status: 'unknown', windows: [] };
    }
  } catch {
    return { status: 'unknown', windows: [] };
  }
  return { status: 'unknown', windows: [] };
}

/** Windows applicable to (provider, pool): Antigravity pools are independent; Claude/Codex standard gates all pools. */
export function applicableWindows(windows, provider, pool = 'standard') {
  const canon = canonicalProvider(provider);
  if (!canon || !Array.isArray(windows)) return [];
  const targetPool = String(pool ?? 'standard').toLowerCase();
  return windows.filter((w) => {
    if (!w || w.provider !== canon) return false;
    if (canon === 'antigravity') return w.pool === targetPool;
    return w.pool === 'standard' || w.pool === targetPool;
  });
}

/**
 * Pace headroom score: min over applicable windows of remainingPct / clamp((resetsAt-now)/(windowMinutes*60000), 1e-4, 1).
 * A window with resetsAt null or <= now contributes 100; no applicable windows returns null.
 */
export function paceScore(windows, provider, pool = 'standard', now = Date.now()) {
  const list = applicableWindows(windows, provider, pool);
  if (list.length === 0) return null;
  let min = Infinity;
  for (const w of list) {
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    let score;
    if (!Number.isFinite(resetMs) || resetMs <= now) {
      score = 100;
    } else {
      const fraction = clamp((resetMs - now) / (w.windowMinutes * 60_000), 1e-4, 1);
      score = w.remainingPct / fraction;
    }
    if (score < min) min = score;
  }
  return min;
}

/** Cooldown lock descriptor { key, scope, tier? } for a (provider, pool) quota window. */
export function lockKeyForWindow(provider, pool = 'standard') {
  const canon = canonicalProvider(provider);
  const targetPool = String(pool ?? 'standard').toLowerCase();
  if (canon === 'antigravity') {
    return { key: `tier:antigravity:${targetPool}`, scope: 'tier', tier: targetPool };
  }
  if (targetPool === 'standard') {
    return { key: `provider:${canon}`, scope: 'provider' };
  }
  return { key: `tier:${canon}:${targetPool}`, scope: 'tier', tier: targetPool };
}

function parseIso(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sanitizeProviderMap(rawProviders) {
  const out = {};
  if (!isObject(rawProviders)) return out;
  for (const [provider, entry] of Object.entries(rawProviders)) {
    const canon = canonicalProvider(provider);
    if (!canon || !isObject(entry)) continue;
    const status = entry.status === 'ok' ? 'ok' : 'unknown';
    const windows = Array.isArray(entry.windows) ? entry.windows.map(sanitizeWindow).filter(Boolean) : [];
    const ok = status === 'ok' && windows.length > 0;
    const checkedAt = parseIso(entry.checkedAt);
    out[canon] = { status: ok ? 'ok' : 'unknown', checkedAt, windows: ok ? windows : [] };
  }
  return out;
}

/** True when a provider cache entry has a valid checkedAt within ttlMs of now. */
export function isProviderFresh(entry, now = Date.now(), ttlMs = QUOTA_TTL_MS) {
  if (!isObject(entry) || typeof entry.checkedAt !== 'string') return false;
  const checkedMs = Date.parse(entry.checkedAt);
  const effectiveTtl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : QUOTA_TTL_MS;
  return Number.isFinite(checkedMs) && now - checkedMs < effectiveTtl;
}

const flattenWindows = (providers) => Object.values(providers).flatMap((entry) => entry.windows ?? []);

/** Reads auto-build-quota.json without running CLIs. Never throws. Tracks per-provider staleness. */
export function readQuotaCache(configDir, now = Date.now(), { ttlMs: ttlOverride } = {}) {
  const file = path.join(configDir, QUOTA_FILE);
  try {
    const raw = readJson(file);
    if (isObject(raw) && raw.schemaVersion === CACHE_SCHEMA_VERSION && isObject(raw.providers)) {
      const topCheckedAt = parseIso(raw.checkedAt);
      const storedTtl = Number.isInteger(raw.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : QUOTA_TTL_MS;
      const effectiveTtl = Number.isInteger(ttlOverride) && ttlOverride > 0 ? ttlOverride : storedTtl;
      const providers = sanitizeProviderMap(raw.providers);
      const entries = Object.entries(providers);
      const staleByProvider = Object.fromEntries(
        entries.map(([provider, entry]) => [provider, !isProviderFresh(entry, now, effectiveTtl)]),
      );
      const stale = entries.length === 0
        ? !(topCheckedAt && now - Date.parse(topCheckedAt) < effectiveTtl)
        : Object.values(staleByProvider).some(Boolean);
      return {
        data: {
          schemaVersion: CACHE_SCHEMA_VERSION,
          checkedAt: topCheckedAt,
          ttlMs: storedTtl,
          providers,
        },
        stale,
        staleByProvider,
      };
    }
  } catch {
    // missing or malformed cache
  }
  return { data: null, stale: true, staleByProvider: {} };
}

/** Writes threshold auto-locks for windows with remainingPct <= minRemainingPct and resetsAt > now, never shortening longer locks. */
export function applyQuotaLocks(configDir, windows, {
  now = Date.now(), minRemainingPct = QUOTA_DEFAULTS.minRemainingPct,
} = {}) {
  const triggered = {};
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !(w.remainingPct <= minRemainingPct)) continue;
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!(resetMs > now)) continue;
    const windowCap = Number.isFinite(w.windowMinutes) && w.windowMinutes > 0
      ? now + w.windowMinutes * 60_000
      : now + MAX_LOCK;
    const untilMs = Math.min(resetMs, windowCap, now + MAX_LOCK);
    if (!(untilMs > now)) continue;
    const { key, scope, tier } = lockKeyForWindow(w.provider, w.pool);
    const until = new Date(untilMs).toISOString();
    if (Date.parse(triggered[key]?.until) >= untilMs) continue;
    triggered[key] = {
      scope,
      window: w.windowMinutes >= 10_080 ? 'weekly' : '5h',
      until,
      reason: `quota ${w.remainingPct}% remaining`,
      source: 'quota',
      ...(tier ? { tier } : {}),
    };
  }
  if (Object.keys(triggered).length === 0) return {};
  const cooldownFile = path.join(configDir, COOLDOWN_FILE);
  try {
    let recorded = {};
    updateCooldowns(cooldownFile, (stored) => {
      const longer = Object.entries(triggered)
        .filter(([key, { until }]) => !(Date.parse(stored[key]?.until) >= Date.parse(until)));
      const next = { ...stored, ...Object.fromEntries(longer) };
      recorded = Object.fromEntries(Object.keys(triggered).map((key) => [key, next[key]]));
      return longer.length ? { data: next } : null;
    }, { now });
    return recorded;
  } catch (error) {
    warn(`quota auto-lock not recorded (${error?.message ?? error})`);
    return {};
  }
}

/**
 * Returns cached quota if fresh per provider (unless refresh=true), else reads live provider quotas, updates
 * auto-build-quota.json atomically under file lock with per-provider checkedAt, and applies threshold auto-locks.
 * Pass `signal` (AbortSignal) to cancel cache and lock writes if the caller gives up before readers finish.
 */
export async function refreshQuota(configDir, {
  providers, runner, rpcRunner, which, claudeUsage, refresh = false, now = Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS, ttlMs, minRemainingPct, signal,
} = {}) {
  const config = loadConfig(configDir);
  const quotaCfg = config.quota ?? {};
  const effectiveTtl = Number.isInteger(ttlMs) && ttlMs > 0
    ? ttlMs
    : (Number.isInteger(quotaCfg.ttlMs) && quotaCfg.ttlMs > 0 ? quotaCfg.ttlMs : QUOTA_TTL_MS);
  const effectiveClaude = claudeUsage ?? quotaCfg.claudeUsage ?? QUOTA_DEFAULTS.claudeUsage;
  const effectiveMinPct = minRemainingPct ?? quotaCfg.minRemainingPct ?? QUOTA_DEFAULTS.minRemainingPct;
  const names = [...new Set((providers?.length ? providers : PROVIDERS).map((p) => canonicalProvider(p)).filter(Boolean))];
  const requested = new Set(names);

  const cached = readQuotaCache(configDir, now, { ttlMs: effectiveTtl });
  const cachedProviders = cached.data?.providers ?? {};
  const toFetch = refresh
    ? names
    : names.filter((p) => !isProviderFresh(cachedProviders[p], now, effectiveTtl));

  const freshWindowsFor = (map) => flattenWindows(Object.fromEntries(
    Object.entries(map).filter(([p, entry]) => requested.has(p) && isProviderFresh(entry, now, effectiveTtl)),
  ));

  if (toFetch.length === 0) {
    const checkedTimes = names.map((p) => Date.parse(cachedProviders[p]?.checkedAt)).filter(Number.isFinite);
    const checkedAt = checkedTimes.length ? new Date(Math.min(...checkedTimes)).toISOString() : (cached.data?.checkedAt ?? null);
    return {
      checkedAt,
      stale: false,
      providers: cachedProviders,
      windows: freshWindowsFor(cachedProviders),
      locks: {},
    };
  }

  const abortedResult = () => ({
    checkedAt: cached.data?.checkedAt ?? null,
    stale: true,
    providers: cachedProviders,
    windows: freshWindowsFor(cachedProviders),
    locks: {},
  });
  if (signal?.aborted) return abortedResult();

  const checkedAt = new Date(now).toISOString();
  const fetchAll = Promise.all(toFetch.map(async (provider) => [
    provider,
    {
      ...(await readProviderQuota(provider, { runner, rpcRunner, which, claudeUsage: effectiveClaude, now, timeoutMs })),
      checkedAt,
    },
  ]));
  let results;
  if (signal) {
    let onAbort;
    const aborted = new Promise((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      results = await Promise.race([fetchAll, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (results === null || signal.aborted) return abortedResult();
  } else {
    results = await fetchAll;
  }

  const freshProviders = sanitizeProviderMap(Object.fromEntries(results));
  const cacheFile = path.join(configDir, QUOTA_FILE);

  const keepFreshExisting = (existing) => Object.fromEntries(
    Object.entries(existing).filter(([p, entry]) => !Object.hasOwn(freshProviders, p) && isProviderFresh(entry, now, effectiveTtl)),
  );

  let mergedProviders = sanitizeProviderMap({ ...keepFreshExisting(cachedProviders), ...freshProviders });
  try {
    withFileLock(cacheFile, (stillHeld) => {
      if (signal?.aborted) return;
      const existing = readQuotaCache(configDir, now, { ttlMs: effectiveTtl }).data?.providers ?? {};
      mergedProviders = sanitizeProviderMap({ ...keepFreshExisting(existing), ...freshProviders });
      const payload = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        checkedAt,
        ttlMs: effectiveTtl,
        providers: mergedProviders,
      };
      if (!stillHeld()) throw lockError(`lost lock ${path.basename(cacheFile)}.lock before write`);
      writeFileAtomic(cacheFile, `${JSON.stringify(payload, null, 2)}\n`);
    });
  } catch (error) {
    warn(`quota cache not written (${error?.message ?? error})`);
  }

  if (signal?.aborted) return abortedResult();
  const freshWindows = flattenWindows(freshProviders);
  const locks = applyQuotaLocks(configDir, freshWindows, { now, minRemainingPct: effectiveMinPct });
  return {
    checkedAt,
    stale: false,
    providers: mergedProviders,
    windows: freshWindowsFor(mergedProviders),
    locks,
  };
}

// Cooldown (rate limit / quota lockout) state shared by the installed hooks. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalProvider, exactProvider, inferProvider, isObject, isStringList, modelKeys, normalizeName, parseJson,
  resolveTarget, warn,
} from './_shared.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A parsed reset time comes from message text, so it can never lock for longer than this.
const MAX_LOCK = 14 * DAY;
export const RECHECK_AFTER = 360 * MINUTE;

/** A lock lasting more than RECHECK_AFTER past setAt gets a recheckAfter time; others are returned unchanged. */
export function withRecheck(entry, now = Date.now()) {
  if (!Number.isNaN(Date.parse(entry.recheckAfter))) return entry;
  const setAt = Date.parse(entry.setAt) || now;
  if (!(Date.parse(entry.until) - setAt > RECHECK_AFTER)) return entry;
  return { ...entry, setAt: new Date(setAt).toISOString(), recheckAfter: new Date(setAt + RECHECK_AFTER).toISOString() };
}

const HEAVY_MODELS = { claude: ['Claude Opus 5.5'], codex: ['gpt-6-luna'], antigravity: ['Gemini 4 Carbon'] };
export const SCARCE_POOL = { claude: 'fable', codex: 'astra', antigravity: 'third-party-claude' };

const untilOf = (entry) => {
  const text = entry?.until ?? entry?.until_utc;
  return typeof text === 'string' ? Date.parse(text) : NaN;
};

/** Legacy entries (until_utc, no window/source) in the current shape. Throws on an entry without a valid time. */
function canonical(key, value) {
  const until = untilOf(value);
  if (!isObject(value) || Number.isNaN(until)) throw new TypeError('cooldown entry without a valid until');
  const { until_utc: legacy, ...rest } = value;
  const prefix = key.match(/^(model|provider|tier):/i)?.[1];
  return {
    ...rest,
    scope: String(value.scope ?? prefix ?? '').toLowerCase(),
    window: value.window ?? 'custom',
    until: new Date(until).toISOString(),
    reason: String(value.reason ?? ''),
    source: value.source ?? 'manual',
  };
}

const canonicalAll = (data) => {
  if (!isObject(data)) throw new TypeError('cooldown file is not a JSON object');
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, canonical(key, value)]));
};

/** The file's raw map: {} when it is missing or blank; throws when it is not a JSON object. */
function readRaw(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const data = text.trim() ? parseJson(text) : {};
  if (!isObject(data)) throw new TypeError('cooldown file is not a JSON object');
  return data;
}

const isValid = (key, value) => {
  const validKey = /^(?:model:[^:]+(?::[^:]+)?|provider:[^:]+|tier:[^:]+:[a-z0-9-]+)$/i.test(key)
    || !/^(?:model|provider|tier):/i.test(key);
  if (!validKey) return false;
  try {
    return Boolean(canonical(key, value));
  } catch {
    return false;
  }
};

/** The valid entries; each invalid one is passed to onInvalid (by default a warning) and skipped. */
export function readCooldowns(file, onInvalid = (key) =>
  warn(`ignoring ${path.basename(file)} entry "${clip(key, 60)}" (invalid)`)) {
  return Object.fromEntries(Object.entries(readRaw(file)).flatMap(([key, value]) => {
    if (isValid(key, value)) return [[key, canonical(key, value)]];
    onInvalid(key);
    return [];
  }));
}

/**
 * Atomic replace; an empty map removes the file. Invalid entries already in the file are kept as they are,
 * unless data replaces their key or `remove` names it.
 */
export function writeCooldowns(file, data, { remove = [], now = Date.now() } = {}) {
  const invalid = Object.entries(readRaw(file))
    .filter(([key, value]) => !Object.hasOwn(data, key) && !remove.includes(key) && !isValid(key, value));
  const stamped = Object.entries(canonicalAll(data)).map(([key, entry]) => [key, withRecheck(entry, now)]);
  const entries = Object.fromEntries([...stamped, ...invalid]);
  if (Object.keys(entries).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** Splits entries into still active (kept) and expired (removed). */
export function prune(data, now = Date.now()) {
  const split = (active) => Object.fromEntries(Object.entries(data).filter(([, entry]) => (untilOf(entry) > now) === active));
  return { kept: split(true), removed: split(false) };
}

function matches(key, scope, { provider, providers, model, config }) {
  const declarations = [...new Set((providers ?? (provider === undefined ? [] : [provider]))
    .filter((id) => typeof id === 'string' && id.trim() !== ''))];
  const declared = [...new Set(declarations.map(canonicalProvider).filter(Boolean))];
  const inferred = inferProvider(model);
  const targets = [];
  const target = resolveTarget({ providers: declarations, model }, config);
  targets.push(target);
  // A conflict is blocked separately by pre-tool-use, but cooldowns remain conservative for both sides.
  const candidates = target.conflict ? [...new Set([...declared, inferred].filter(Boolean))] : [];
  for (const candidate of candidates) {
    targets.push(resolveTarget({ providers: [candidate], model }, config));
  }

  if (scope === 'provider') {
    const wantedRaw = key.replace(/^provider:/i, '');
    const compactKey = wantedRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wantedProvider = ['claude', 'claudeagent', 'codex', 'antigravity'].includes(compactKey)
      ? canonicalProvider(wantedRaw) : null;
    const wanted = normalizeName(wantedRaw);
    const ids = new Set([
      ...declarations.map((id) => normalizeName(id)),
      ...declared,
      ...targets.map((item) => item.provider).filter(Boolean),
      // Unknown aliases may still carry a model from a known provider.
      ...(!declared.length || target.conflict ? [inferred] : []),
    ].filter(Boolean).map(normalizeName));
    return (wantedProvider ? ids.has(wantedProvider) : ids.has(wanted));
  }

  const modelMatch = (name) => {
    if (!model) return false;
    const keys = modelKeys(model, config);
    return [...modelKeys(name, config)].some((candidate) => keys.has(candidate));
  };
  if (scope === 'model') {
    const match = key.match(/^model:([^:]+):(.+)$/i);
    if (match) {
      const exact = exactProvider(match[1]);
      const wanted = exact ?? normalizeName(match[1]);
      const hostMatch = exact
        ? (item) => normalizeName(item.provider ?? '') === exact
        : () => declarations.some((id) => normalizeName(id) === wanted);
      return targets.some((item) => hostMatch(item) && modelMatch(match[2]));
    }
    return modelMatch(key.replace(/^model:/i, ''));
  }

  const tier = key.match(/^tier:([^:]+):([a-z0-9-]+)$/i);
  if (!tier) return false;
  const [, providerKey, pool] = tier;
  const exact = exactProvider(providerKey);
  const wanted = exact ?? normalizeName(providerKey);
  const hostMatch = exact
    ? (item) => normalizeName(item.provider ?? '') === exact
    : () => declarations.some((id) => normalizeName(id) === wanted);
  if (pool.toLowerCase() === 'heavy') {
    const family = exact ?? canonicalProvider(providerKey) ?? wanted;
    const configured = config?.tiers?.[family]?.heavyModels;
    const legacyModels = isStringList(configured) ? configured : HEAVY_MODELS[family] ?? [];
    return targets.some((item) => hostMatch(item)
      && (legacyModels.some(modelMatch) || item.pool === SCARCE_POOL[family]));
  }
  return targets.some((item) => hostMatch(item) && item.pool === pool.toLowerCase());
}

/** The matching active lock that ends last, or null. A missing or unknown provider is inferred from the model. */
export function isLocked(data, { provider, providers, model, config } = {}, now = Date.now()) {
  const request = { provider, providers, model, config };
  let lock = null;
  for (const [key, value] of Object.entries(data)) {
    const until = untilOf(value);
    if (!(until > now) || (lock && until <= Date.parse(lock.until))) continue;
    const { scope, window, reason, until: iso } = canonical(key, value);
    if (matches(key, scope, request)) lock = { key, scope, window, until: iso, reason };
  }
  return lock;
}

// File text goes into the session context, so it is kept to one short line.
const clip = (text, max) => String(text).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').slice(0, max);

/** At most 3 lines describing the active lockouts; [] when there are none. */
export function summarize(data, now = Date.now()) {
  const active = Object.entries(prune(data, now).kept).map(([key, value]) => [key, canonical(key, value)]);
  if (active.length === 0) return [];
  const line = (label, entries) => {
    if (entries.length === 0) return [];
    const shown = entries.slice(0, 10).map(([key, { until, reason }]) =>
      `${clip(key, 60)} until ${until} (${Math.ceil((Date.parse(until) - now) / MINUTE)}m left: ${clip(reason, 60)})`);
    if (entries.length > 10) shown.push(`+${entries.length - 10} more`);
    return [`${label}: ${shown.join('; ')}`];
  };
  return [
    'ACTIVE AUTO-BUILD COOLDOWNS (orchestrator: skip these locked providers/models):',
    ...line('Providers and tiers', active.filter(([, entry]) => entry.scope !== 'model')),
    ...line('Models', active.filter(([, entry]) => entry.scope === 'model')),
  ];
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAME = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\b';
const RESET_DAY = new RegExp(`\\bresets?\\s+(?:on\\s+)?(${DAY_NAME})`, 'i');
const WEEKLY = /\bweek(?:ly)?\b/i;
const CLOCK = /\b(?:resets?(?:\s+at)?|try again at)\s+(\d{1,2})(?::(\d{2})(?:\s*([ap])\.?m\b\.?)?|\s*([ap])\.?m\b\.?)(?:\s*(utc|gmt|z)\b)?/i;
const FIVE_HOUR = /\b(?:5|five)[\s-]*(?:h|hrs?|hours?)\b|\b(?:session|usage) limit\b|\bin\s+\d+\s*(?:h(?![a-z])|hrs?\b|hours?\b)/i;
const UNIT = '(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])';
const DURATION = new RegExp(`\\b(?:in|after)\\s+((?:\\d+\\s*${UNIT}[\\s,]*(?:and\\s+)?)+)`, 'i');
const RETRY_AFTER = /retry[- ]after["']?[:=\s]+["']?(\d+)(?![\d-]|\s*[mhd])/i;
const UNIT_MS = { d: DAY, h: 60 * MINUTE, m: MINUTE, s: 1000 };

const isoIn = (text) => Date.parse(text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0] ?? '');

function durationIn(text) {
  const parts = [...(text.match(DURATION)?.[1] ?? '').matchAll(/(\d+)\s*([dhms])[a-z]*/gi)];
  return parts.length ? parts.reduce((total, [, n, unit]) => total + n * UNIT_MS[unit.toLowerCase()], 0) : NaN;
}

/** Next occurrence of a "resets 3pm" / "resets at 15:30" (or "... UTC") time. */
function clockIn(text, now) {
  const match = text.match(CLOCK);
  if (!match) return NaN;
  const half = (match[3] ?? match[4])?.toLowerCase();
  const utc = Boolean(match[5]);
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || (half ? hour < 1 || hour > 12 : hour > 23)) return NaN;
  if (half) hour = (hour % 12) + (half === 'p' ? 12 : 0);
  const date = new Date(now);
  if (utc) {
    date.setUTCHours(hour, minute, 0, 0);
    if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  } else {
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

/** Next 00:00Z of a weekday given as a name or 0 (Sunday) to 6. */
function weekdayAt(day, now) {
  const index = typeof day === 'string' ? WEEKDAYS.indexOf(day.trim().slice(0, 3).toLowerCase()) : day;
  if (!Number.isInteger(index) || index < 0 || index > 6) return NaN;
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + (((index - date.getUTCDay() + 7) % 7) || 7));
  return date.getTime();
}

/** Classifies a rate-limit message (weekly, then 5h, then burst) and works out when it resets. */
export function parseRateLimit(text, { now = Date.now(), sharing, resetDay, retryAfter } = {}) {
  const message = String(text ?? '');
  const at = Number(now);
  // The first candidate in the future wins, capped at MAX_LOCK; the last one is the default.
  const result = (window, scope, ...candidates) => ({
    window, scope, until: new Date(Math.min(candidates.find((time) => time > at), at + MAX_LOCK)).toISOString(),
  });
  const day = message.match(RESET_DAY)?.[1];
  if (WEEKLY.test(message) || day) {
    return result('weekly', 'provider', isoIn(message), weekdayAt(day, at), weekdayAt(resetDay, at), at + 7 * DAY);
  }
  const clock = clockIn(message, at);
  if (FIVE_HOUR.test(message) || !Number.isNaN(clock)) {
    return result('5h', sharing === 'heavy-tier-only' ? 'tier' : 'provider',
      isoIn(message), at + durationIn(message), clock, at + 300 * MINUTE);
  }
  return result('burst', 'model', at + Number(retryAfter ?? NaN) * 1000,
    at + Number(message.match(RETRY_AFTER)?.[1] ?? NaN) * 1000, at + durationIn(message), at + 10 * MINUTE);
}

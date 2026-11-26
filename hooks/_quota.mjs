// Cooldown (rate limit / quota lockout) state shared by the installed hooks. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import { inferProvider, isObject, isStringList, modelKeys, normalizeName, parseJson } from './_shared.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// T3 provider ids to provider keys. Custom instances (codex-2) resolve by driverKind or this prefix.
const PROVIDERS = new Map([['claudeagent', 'claude'], ['claude', 'claude'], ['codex', 'codex'], ['antigravity', 'antigravity']]);
const compact = (id) => id.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEAVY_MODELS = { claude: ['Claude Opus 5.5'], codex: ['gpt-6-luna'], antigravity: ['Gemini 4 Carbon'] };

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

/** {} when the file is missing or blank; throws when it is malformed. */
export function readCooldowns(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return text.trim() ? canonicalAll(parseJson(text)) : {};
}

/** Atomic replace; an empty map removes the file. */
export function writeCooldowns(file, data) {
  const entries = canonicalAll(data);
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

function matches(key, scope, { provider, model, config }) {
  if (scope === 'provider') {
    const aliasOf = (id) => [...PROVIDERS.keys()].find((prefix) => compact(id).startsWith(prefix));
    // A custom instance id ("work") says nothing about its provider, so the model decides too.
    const ids = [provider, !(provider && aliasOf(provider)) && inferProvider(model)].filter(Boolean);
    // Only exact aliases apply to the key, so a "codex-2" cooldown does not block every Codex instance.
    const name = key.replace(/^provider:/i, '');
    const wanted = normalizeName(PROVIDERS.get(compact(name)) ?? name);
    return ids.flatMap((id) => [id, PROVIDERS.get(aliasOf(id)) ?? id]).some((id) => normalizeName(id) === wanted);
  }
  if (!model) return false;
  const keys = modelKeys(model, config);
  const hit = (name) => [...modelKeys(name, config)].some((k) => keys.has(k));
  if (scope === 'model') return hit(key.replace(/^model:/i, ''));
  const tier = scope === 'tier' && key.match(/^tier:([^:]+):heavy$/i)?.[1].toLowerCase();
  if (!tier) return false;
  const configured = config?.tiers?.[tier]?.heavyModels;
  return (isStringList(configured) ? configured : HEAVY_MODELS[tier] ?? []).some(hit);
}

/** The matching active lock that ends last, or null. A missing or unknown provider is inferred from the model. */
export function isLocked(data, { provider, model, config } = {}, now = Date.now()) {
  const request = { provider, model, config };
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
const clip = (text, max) => String(text).replace(/\s+/g, ' ').slice(0, max);

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
const CLOCK = /\b(?:resets?(?:\s+at)?|try again at)\s+(\d{1,2})(?::(\d{2})(?:\s*([ap])\.?m\b)?|\s*([ap])\.?m\b)/i;
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

/** Next local occurrence of a "resets 3pm" / "resets at 15:30" time. */
function clockIn(text, now) {
  const match = text.match(CLOCK);
  if (!match) return NaN;
  const half = (match[3] ?? match[4])?.toLowerCase();
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || (half ? hour < 1 || hour > 12 : hour > 23)) return NaN;
  if (half) hour = (hour % 12) + (half === 'p' ? 12 : 0);
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
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
  // The first candidate that is a real future time wins; the last one is the default.
  const result = (window, scope, ...candidates) => ({
    window, scope, until: new Date(candidates.find((time) => time > at && time < 8.64e15)).toISOString(),
  });
  const day = message.match(RESET_DAY)?.[1];
  if (WEEKLY.test(message) || day) {
    return result('weekly', 'provider', isoIn(message), weekdayAt(day, at), weekdayAt(resetDay, at), at + 7 * DAY);
  }
  if (FIVE_HOUR.test(message) || CLOCK.test(message)) {
    return result('5h', sharing === 'heavy-tier-only' ? 'tier' : 'provider',
      isoIn(message), at + durationIn(message), clockIn(message, at), at + 300 * MINUTE);
  }
  return result('burst', 'model', at + Number(retryAfter ?? NaN) * 1000,
    at + Number(message.match(RETRY_AFTER)?.[1] ?? NaN) * 1000, at + durationIn(message), at + 10 * MINUTE);
}

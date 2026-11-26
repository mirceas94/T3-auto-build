// Manual cooldown locks and the login-status check behind `t3-auto-build quota`. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import {
  COOLDOWN_FILE, cliModelId, inferProvider, loadConfig, modelKeys, normalizeModel, which as findOnPath,
} from '../hooks/_shared.mjs';
import { isLocked, parseRateLimit, prune, readCooldowns, writeCooldowns } from '../hooks/_quota.mjs';
import { HEAVY_MODELS } from './detect.mjs';
import { CliError } from './paths.mjs';
import { createRunner } from './probe.mjs';

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

/** { provider } for a provider name, else { model, id } for a model this config or a known family names. */
function resolveSubject(subject, config) {
  const text = String(subject ?? '').trim();
  const lower = text.toLowerCase();
  if (isProvider(lower)) return { provider: lower };
  const model = normalizeModel(text);
  const wanted = modelKeys(model, config);
  const known = [...Object.values(config.allowlist).flat(), ...Object.keys(config.modelIds ?? {})]
    .some((name) => [...modelKeys(name, config)].some((key) => wanted.has(key)));
  if (!text || (!known && !inferProvider(model))) {
    throw new CliError(`unknown provider or model "${clean(text)}"; use ${Object.keys(HEAVY_MODELS).join(', ')} or a model name`, 2);
  }
  return { model, id: cliModelId(inferProvider(model), model, config) };
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
export function quotaSet(target, subject, { window, until, reason, now = Date.now(), log = console.log } = {}) {
  if (window !== undefined && until !== undefined) throw new CliError('give a window or --until, not both', 2);
  const span = until === undefined ? window ?? 'burst' : 'custom';
  if (span !== 'custom' && !QUOTA_WINDOWS.includes(span)) throw new CliError(`unknown window "${clean(span)}"`, 2);
  const config = loadConfig(target);
  const { provider, id } = resolveSubject(subject, config);
  const tier = config.tiers?.[provider ?? inferProvider(id)];
  const limit = span === 'custom'
    ? { until: new Date(parseUntil(until, now)).toISOString() }
    : parseRateLimit({ burst: '', '5h': '5h limit', weekly: 'weekly limit' }[span], {
      now, sharing: tier?.sharing, resetDay: tier?.resetDay,
    });
  let scope = provider ? 'provider' : 'model';
  if (provider && span === '5h' && limit.scope === 'tier') scope = 'tier';
  const key = { model: `model:${id}`, provider: `provider:${provider}`, tier: `tier:${provider}:heavy` }[scope];
  const entry = {
    scope, window: span, until: limit.until, reason: reason ?? `manual lock (${span})`, source: 'manual',
    ...(scope === 'tier' && { tier: 'heavy' }),
  };
  writeCooldowns(cooldownPath(target), { ...prune(load(target), now).kept, [key]: entry });
  log(`locked ${key} until ${entry.until} (${span})`);
  return { key, entry };
}

function countdown(ms) {
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
  const { kept, removed } = prune(load(target), now);
  if (Object.keys(removed).length) writeCooldowns(cooldownPath(target), kept);
  const locks = Object.entries(kept).map(([key, entry]) => ({ key, ...entry }));
  if (!locks.length) log('no active cooldowns');
  for (const { key, window, until, reason, source } of locks) {
    log(`${clean(key)}: ${countdown(Date.parse(until) - now)} left, resets ${until} `
      + `(${clean(window)}, ${clean(source)}: ${clean(reason)})`);
  }
  return locks;
}

/** subject: a provider or model name, or { all: true }. Returns the removed keys (null for all). */
export function quotaClear(target, subject, { log = console.log } = {}) {
  if (subject?.all) {
    fs.rmSync(cooldownPath(target), { force: true }); // also the way out of a corrupt file
    log('cleared all cooldowns');
    return null;
  }
  const config = loadConfig(target);
  const { provider, model } = resolveSubject(subject, config);
  const bad = [];
  const data = load(target, (key) => bad.push(key));
  // A malformed entry has no usable fields, so it is matched by its key alone.
  const stubs = bad.map((key) => [key, {
    scope: key.match(/^(model|provider|tier):/i)?.[1].toLowerCase() ?? (provider ? 'provider' : 'model'),
    until: '9999-01-01T00:00:00Z',
  }]);
  const removed = [...Object.entries(data), ...stubs].filter(([key, entry]) => {
    if (provider && entry.scope === 'tier') return key.toLowerCase() === `tier:${provider}:heavy`;
    // Time 0 makes isLocked match expired entries too.
    return entry.scope === (provider ? 'provider' : 'model')
      && isLocked({ [key]: entry }, { provider, model, config }, 0) !== null;
  }).map(([key]) => key);
  for (const key of removed) delete data[key];
  if (removed.length) writeCooldowns(cooldownPath(target), data, { remove: removed });
  log(removed.length ? `cleared: ${removed.map(clean).join(', ')}` : `no cooldown recorded for ${clean(subject)}`);
  return removed;
}

// Confirmed official commands. They report login state; there is no documented Antigravity equivalent.
const STATUS = { claude: ['auth', 'status'], codex: ['login', 'status'] };
const EXHAUSTED = /(?<![\d.])(?:0(?:\.0+)?\s*% (?:remaining|left)|100(?:\.0+)?\s*% (?:used|consumed))\b|\blimit (?:has been )?(?:reached|exceeded|exhausted)\b|\b(?:hit|reached) your (?:[\w-]+ ){0,3}limit\b/i;
// "no limit reached" or "when the limit is reached" is not exhaustion.
const HEDGED = /(?:\b(?:no|not|never|if|when|once|until|before)\b|n't\b)[^.;]*$/i;

/** Runs the status commands and records a lock only for explicitly reported exhaustion. Output is never logged. */
export async function quotaCheck(target, { providers, runner, which = findOnPath, now = Date.now(), log = console.log } = {}) {
  const names = providers?.length ? providers.map((p) => p.toLowerCase()) : Object.keys(HEAVY_MODELS);
  const unknown = names.find((name) => !isProvider(name));
  if (unknown !== undefined) throw new CliError(`unknown provider "${clean(unknown)}"; use ${Object.keys(HEAVY_MODELS).join(', ')}`, 2);
  const exec = runner ?? createRunner(which);
  const config = loadConfig(target);
  const locks = {};
  for (const provider of names) {
    const fallback = (why) => log(`${provider}: ${why}; using recorded cooldowns`);
    if (!STATUS[provider]) {
      fallback('no official status command');
      continue;
    }
    let res;
    try {
      res = await exec(provider, STATUS[provider], { timeout: 15_000 });
    } catch {
      res = null;
    }
    if (!res || res.error) {
      const code = res?.error?.code;
      fallback(code === 'ENOENT' ? 'cli not found' : code === 'ETIMEDOUT' ? 'status check timed out' : 'status check failed');
      continue;
    }
    const lines = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.split(/\r?\n/);
    const found = {};
    lines.forEach((line, i) => {
      const match = EXHAUSTED.exec(line);
      if (!match || HEDGED.test(line.slice(0, match.index))) return;
      const reset = /^\s*resets?\b/i.test(lines[i + 1] ?? '') ? ` ${lines[i + 1]}` : '';
      const tier = config.tiers?.[provider];
      const limit = parseRateLimit(`${line}${reset}`, { now, sharing: tier?.sharing, resetDay: tier?.resetDay });
      const scope = limit.scope === 'tier' ? 'tier' : 'provider';
      const key = scope === 'tier' ? `tier:${provider}:heavy` : `provider:${provider}`;
      if (Date.parse(found[key]?.until) >= Date.parse(limit.until)) return;
      found[key] = {
        scope, window: limit.window, until: limit.until, reason: `usage exhausted (${limit.window})`, source: 'probe',
        ...(scope === 'tier' && { tier: 'heavy' }),
      };
    });
    if (Object.keys(found).length === 0) {
      fallback(`${res.status === 0 ? 'logged in' : 'not logged in or status failed'}; usage not exposed`);
    }
    Object.assign(locks, found);
  }
  if (Object.keys(locks).length === 0) return locks;
  try {
    const stored = load(target);
    // An existing lock that lasts longer is never shortened.
    const longer = Object.entries(locks).filter(([key, { until }]) => !(Date.parse(stored[key]?.until) >= Date.parse(until)));
    const next = { ...stored, ...Object.fromEntries(longer) };
    writeCooldowns(cooldownPath(target), next);
    for (const key of Object.keys(locks)) log(`${key}: usage exhausted; locked until ${next[key].until}`);
  } catch (error) {
    log(`warning: lockout not recorded: ${error.message}`);
  }
  return locks;
}

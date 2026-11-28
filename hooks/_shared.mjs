// Shared by the installed hooks (and reused by the installer). Node >=18, node:* only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_OVERRIDES_FILE, POOLS, PROVIDERS, RETIRED_MODELS, SCARCE_POOL, inferProvider, isObject, isStringList,
  loadCatalogOverrides, matchRetired, normalizeModel, normalizeName, validateCatalogOverrides,
} from './_catalog.mjs';

export {
  CATALOG_OVERRIDES_FILE, POOLS, PROVIDERS, RETIRED_MODELS, SCARCE_POOL, inferProvider, isObject, isStringList,
  loadCatalogOverrides, matchRetired, normalizeModel, normalizeName, validateCatalogOverrides,
};

export const CONFIG_FILE = 'auto-build.config.json';
export const COOLDOWN_FILE = 'auto-build-cooldowns.json';
export const AVAILABILITY_FILE = 'auto-build-availability.json';
export const QUOTA_FILE = 'auto-build-quota.json';
export const RUNTIME_SNAPSHOT_FILE = 'auto-build-runtime.json';
export const LEDGER_FILE = 'auto-build-ledger.jsonl';
export const SCHEMA_VERSION = 3;

export const QUOTA_DEFAULTS = Object.freeze({
  minRemainingPct: 3,
  ttlMs: 300_000,
  claudeUsage: true,
  burstLockMs: 300_000,
});

export const DEFAULTS = {
  allowlist: {
    Codex: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'],
    Antigravity: ['Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Gemini 4 Carbon'],
    Claude: ['Claude Haiku 5.5', 'Claude Sonnet 5.5', 'Claude Opus 5.5'],
  },
  bannedModels: [],
};

export const warn = (message) => process.stderr.write(`t3-auto-build: ${message}\n`);

export const isAllowlist = (v) =>
  isObject(v) && Object.values(v).every(isStringList) && Object.values(v).flat().length > 0;

const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(WAIT_ARRAY, 0, 0, ms);
};

/** Retries transient Windows file-busy errors (scanners, concurrent readers/writers). */
export function retryBusy(action, { attempts = 6, delayMs = 25 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= attempts || !BUSY_CODES.has(error?.code)) throw error;
      sleepSync(delayMs);
    }
  }
}

/** Removes a file if present, retrying transient busy errors. */
export const removeFile = (file) => retryBusy(() => fs.rmSync(file, { force: true }));

/** Writes content via a unique sibling temp file and atomic rename (with retry and cleanup). */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(temp, content);
    retryBusy(() => fs.renameSync(temp, file));
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

const GUARD_STALE_MS = 5_000;

export function lockError(message) {
  const err = new Error(message);
  err.code = 'ELOCKED';
  return err;
}

const isRetryableOpen = (error) =>
  error?.code === 'EEXIST' || error?.code === 'EISDIR'
  || (process.platform === 'win32' && BUSY_CODES.has(error?.code));

// shortcut: lstatRegular before openSync('wx') has a narrow TOCTOU window (Node exposes no O_NOFOLLOW create on Windows)
function createExclusive(file, content) {
  lstatRegular(file);
  const fd = fs.openSync(file, 'wx');
  let wrote = false;
  try {
    fs.writeSync(fd, content);
    wrote = true;
  } finally {
    fs.closeSync(fd);
    if (!wrote) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function lstatRegular(file) {
  // Windows answers EPERM for a file another process is still deleting.
  const stat = retryBusy(() => fs.lstatSync(file, { throwIfNoEntry: false }));
  if (stat && !stat.isFile()) throw lockError(`lock path ${path.basename(file)} is not a regular file`);
  return stat;
}

function readLockToken(file) {
  try {
    return retryBusy(() => fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function unlinkLockFile(file) {
  try {
    retryBusy(() => fs.unlinkSync(file));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Briefly serializes lock-file unlinks (stale reclaim and release) via an exclusive sibling `.guard` file (`wx`). */
function withLockGuard(guardFile, action, { timeoutMs = 1000, staleMs = GUARD_STALE_MS, pollMs = 5 } = {}) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const guardStaleMs = Math.min(Math.max(staleMs, 250), GUARD_STALE_MS);
  const stepMs = Math.max(1, Math.min(pollMs, 10));
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0 && Date.now() >= deadline) {
      throw lockError(`timed out waiting for lock guard ${path.basename(guardFile)}`);
    }
    try {
      createExclusive(guardFile, token);
      break;
    } catch (error) {
      if (!isRetryableOpen(error)) throw error;
      let stat;
      try {
        stat = lstatRegular(guardFile);
      } catch (statError) {
        if (statError?.code === 'ELOCKED') throw statError;
        stat = undefined;
      }
      if (stat && Date.now() - stat.mtimeMs >= guardStaleMs) {
        try {
          unlinkLockFile(guardFile);
        } catch {
          // another contender or transient error; retry within deadline
        }
        continue;
      }
      if (!stat && error?.code === 'EEXIST') continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lockError(`timed out waiting for lock guard ${path.basename(guardFile)}`);
      sleepSync(Math.min(stepMs, remaining));
    }
  }
  try {
    return action();
  } finally {
    try {
      const stat = fs.lstatSync(guardFile, { throwIfNoEntry: false });
      if (stat?.isFile() && readLockToken(guardFile) === token) unlinkLockFile(guardFile);
    } catch {
      // best-effort guard cleanup
    }
  }
}

/**
 * Serializes updates to `file` via an exclusive sibling `.lock` file (`wx`).
 * `action` must be synchronous; async callbacks would release the lock before finishing.
 * Recovers stale locks older than `staleMs` and never waits longer than `timeoutMs`.
 */
// shortcut: a holder past staleMs can overlap its reclaimer, and a guard abandoned by a crash is reclaimed by age; lock bodies are ms-scale sync RMW only
export function withFileLock(file, action, { timeoutMs = 2000, staleMs = 10_000, pollMs = 25 } = {}) {
  const lockFile = `${file}.lock`;
  const guardFile = `${lockFile}.guard`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const releaseLock = () => {
    const stat = fs.lstatSync(lockFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) return;
    if (readLockToken(lockFile) === token) unlinkLockFile(lockFile);
  };
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0 && Date.now() >= deadline) {
      throw lockError(`timed out waiting for lock ${path.basename(lockFile)}`);
    }
    lstatRegular(guardFile);
    try {
      createExclusive(lockFile, token);
      break;
    } catch (error) {
      if (!isRetryableOpen(error)) throw error;
      let stat;
      try {
        stat = lstatRegular(lockFile);
      } catch (statError) {
        if (statError?.code === 'ELOCKED') throw statError;
        stat = undefined;
      }
      if (stat && Date.now() - stat.mtimeMs >= staleMs) {
        let observed;
        let readFailed = false;
        try {
          observed = readLockToken(lockFile);
        } catch {
          readFailed = true;
        }
        if (!readFailed) {
          if (observed === null) continue;
          let reclaimed = false;
          try {
            withLockGuard(guardFile, () => {
              const currentStat = lstatRegular(lockFile);
              if (!currentStat || Date.now() - currentStat.mtimeMs < staleMs) return;
              if (readLockToken(lockFile) !== observed) return;
              unlinkLockFile(lockFile);
              reclaimed = true;
            }, { timeoutMs: Math.max(0, deadline - Date.now()), staleMs, pollMs });
          } catch (reclaimError) {
            if (reclaimError?.code === 'ELOCKED') throw reclaimError;
          }
          if (reclaimed) continue;
        }
      } else if (!stat && error?.code === 'EEXIST') {
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lockError(`timed out waiting for lock ${path.basename(lockFile)}`);
      }
      sleepSync(Math.min(pollMs, remaining));
    }
  }
  try {
    lstatRegular(guardFile);
  } catch (error) {
    try {
      releaseLock();
    } catch {
      // best-effort cleanup when guard became non-regular during acquire
    }
    throw error;
  }
  const stillHeld = () => {
    try {
      const stat = fs.lstatSync(lockFile, { throwIfNoEntry: false });
      return Boolean(stat?.isFile() && readLockToken(lockFile) === token);
    } catch {
      return false;
    }
  };
  try {
    return action(stillHeld);
  } finally {
    try {
      const releaseTimeoutMs = Math.max(500, Math.min(timeoutMs, 2000));
      withLockGuard(guardFile, releaseLock, { timeoutMs: releaseTimeoutMs, staleMs, pollMs });
    } catch (releaseError) {
      let released = false;
      let brokenGuard = false;
      try {
        const guardStat = fs.lstatSync(guardFile, { throwIfNoEntry: false });
        if (guardStat && !guardStat.isFile()) {
          brokenGuard = true;
          releaseLock();
          released = true;
        }
      } catch {
        // best-effort fallback lock cleanup
      }
      if (brokenGuard && released) {
        warn(`lock guard ${path.basename(guardFile)} is not a regular file; released ${path.basename(lockFile)} without guard`);
      } else if (!released) {
        warn(`failed to release lock ${path.basename(lockFile)} (${releaseError?.message ?? releaseError})`);
      }
    }
  }
}

export const parseJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));
export const readJson = (file) => parseJson(retryBusy(() => fs.readFileSync(file, 'utf8')));

/** Config dir of an installed hook: <configDir>/hooks/t3-auto-build/<hook>.mjs */
export const configDirOf = (metaUrl) => path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..');

export function displayPath(configDir, file) {
  const isDefault = path.resolve(configDir) === path.resolve(os.homedir(), '.claude');
  const base = isDefault ? '~/.claude' : path.resolve(configDir).replace(/\\/g, '/');
  return `${base}/${file}`;
}

/** The id a provider CLI takes: config.modelIds first, else the hyphenated name (codex ids keep "."). */
export function cliModelId(provider, displayOrId, config) {
  const ids = config?.modelIds;
  if (isObject(ids) && Object.hasOwn(ids, displayOrId)) return ids[displayOrId];
  const separator = provider?.toLowerCase() === 'codex' ? /[^a-z0-9.]+/g : /[^a-z0-9]+/g;
  return displayOrId.toLowerCase().replace(separator, '-').replace(/^-+|-+$/g, '');
}

/** Comparable forms of a model: date-stripped and normalized, plus the transitive closure of config.modelIds. */
export function modelKeys(model, config) {
  const key = (name) => normalizeName(normalizeModel(name));
  const keys = new Set([key(model)]);
  const pairs = Object.entries(config?.modelIds ?? {})
    .filter(([, id]) => typeof id === 'string')
    .map(([name, id]) => [key(name), key(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [left, right] of pairs) {
      if (keys.has(left) && !keys.has(right)) {
        keys.add(right);
        grew = true;
      } else if (keys.has(right) && !keys.has(left)) {
        keys.add(left);
        grew = true;
      }
    }
  }
  return keys;
}

// T3 provider ids to provider keys. Custom instances (codex-2) resolve by driverKind or this prefix.
export const PROVIDER_ALIASES = new Map([
  ['claudeagent', 'claude'], ['claude', 'claude'], ['codex', 'codex'], ['antigravity', 'antigravity'],
]);

/** Like canonicalProvider without the prefix match: custom instances and model names are null. */
export const exactProvider = (id) => PROVIDER_ALIASES.get(String(id).toLowerCase().replace(/[^a-z0-9]/g, '')) ?? null;

/** 'claude' | 'codex' | 'antigravity' from a provider or instance id, else null. */
export function canonicalProvider(id) {
  if (typeof id !== 'string') return null;
  const compact = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias = [...PROVIDER_ALIASES.keys()].find((prefix) => compact.startsWith(prefix));
  return PROVIDER_ALIASES.get(alias) ?? null;
}

/**
 * Which hosting a request means. A bare model resolves to its native provider; another provider hosts it only when
 * named explicitly and declared in config.models. A set `conflict` means the request must not be trusted.
 */
export function resolveTarget({ providers = [], model } = {}, config) {
  const list = Array.isArray(providers) ? providers : [providers];
  const canon = [...new Set(list.map(canonicalProvider).filter(Boolean))];
  const name = typeof model === 'string' && model ? model : null;
  const keys = name ? modelKeys(name, config) : new Set();
  const inferred = name ? (inferProvider(name) ?? [...keys].map(inferProvider).find(Boolean) ?? null) : null;
  const declared = canon[0] ?? null;
  const models = Array.isArray(config?.models) ? config.models : [];
  const matched = name
    ? models.filter((item) => typeof item?.model === 'string'
      && [...modelKeys(item.model, config)].some((key) => keys.has(key)))
    : [];
  const matchedProviders = [...new Set(matched.map((item) => canonicalProvider(item.provider)).filter(Boolean))];
  const provider = declared ?? inferred ?? (matchedProviders.length === 1 ? matchedProviders[0] : null);
  const entry = provider
    ? matched.find((item) => canonicalProvider(item.provider) === provider) ?? null
    : null;
  let conflict = null;
  if (canon.length > 1) conflict = `conflicting providers: ${canon.join(', ')}`;
  else if (declared && !entry && inferred && declared !== inferred) {
    conflict = `model ${name} is not hosted on provider ${declared}`;
  }
  return {
    provider,
    model: name,
    entry,
    pool: entry?.pool ?? 'standard',
    scarceQuota: Boolean(entry?.scarceQuota),
    crossHosted: Boolean(inferred) && provider !== inferred && Boolean(entry),
    conflict,
  };
}

/** Banned entries match as substrings of the raw or normalized name (and resolved aliases); "A/B" bans both A and B. */
export function isBanned(model, bannedModels, config) {
  const name = model.toLowerCase();
  const normalized = [normalizeName(model)];
  for (const key of modelKeys(model, config)) {
    if (!normalized.includes(key)) normalized.push(key);
  }
  const hasWord = (value) => /[\p{L}\p{N}]/u.test(value);
  return bannedModels
    .flatMap((entry) => entry.split('/'))
    .map((term) => term.trim().toLowerCase())
    // A term with no letter or digit normalizes to "-" (or "" after date-stripping) and would ban nearly everything.
    .some((term) => {
      if (term === '') return false;
      if (name.includes(term)) return true;
      const norm = normalizeName(term);
      if (norm !== '' && hasWord(norm) && normalized.some((key) => key.includes(norm))) return true;
      const stripped = normalizeModel(norm);
      return stripped !== norm && stripped !== '' && hasWord(stripped)
        && normalized.some((key) => key === stripped);
    });
}

/** [provider, models] pairs with banned models removed. */
export function effectiveAllowlist(config) {
  const { allowlist, bannedModels } = config;
  return Object.entries(allowlist)
    .map(([provider, models]) => [provider, models.filter((m) => !isBanned(m, bannedModels, config))])
    .filter(([, models]) => models.length > 0);
}

// Preset files are not installed beside the hooks; each is these providers of DEFAULTS (tests keep them in step).
const PRESET_PROVIDERS = { 'claude-codex': ['Codex', 'Claude'], 'claude-only': ['Claude'] };

function presetDefaults(preset) {
  if (!Object.hasOwn(PRESET_PROVIDERS, preset)) return DEFAULTS;
  const allowlist = Object.fromEntries(PRESET_PROVIDERS[preset].map((name) => [name, DEFAULTS.allowlist[name]]));
  return { ...DEFAULTS, allowlist };
}

export const isV2 = (raw) => raw?.schemaVersion === 2;
export const isV3 = (raw) => raw?.schemaVersion === 3;
export const isSupportedSchema = (raw) => isV2(raw) || isV3(raw);

const isModelList = (v) => Array.isArray(v) && v.every((m) => isObject(m) && isStringList([m.provider, m.model])
  && (m.pool === undefined || typeof m.pool === 'string')
  && (m.scarceQuota === undefined || typeof m.scarceQuota === 'boolean'));
const isBoolean = (v) => typeof v === 'boolean';
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isTelemetry = (v) => isObject(v) && (v.enabled === undefined || isBoolean(v.enabled))
  && (v.maxBytes === undefined || isCount(v.maxBytes));
const isPreflight = (v) => isObject(v) && (v.ttl === undefined || isCount(v.ttl));
const isQuota = (v) => isObject(v)
  && (v.minRemainingPct === undefined || (typeof v.minRemainingPct === 'number' && Number.isFinite(v.minRemainingPct) && v.minRemainingPct >= 0 && v.minRemainingPct <= 100))
  && (v.ttlMs === undefined || isPositiveInt(v.ttlMs))
  && (v.claudeUsage === undefined || isBoolean(v.claudeUsage))
  && (v.burstLockMs === undefined || isCount(v.burstLockMs));
const isToggle = (v) => isBoolean(v) || isObject(v);

/**
 * Missing or invalid keys come from the config's own preset, as in the installer. An unreadable file or an unknown
 * schemaVersion gives DEFAULTS, so an allowlist is always enforced.
 */
export function loadConfig(configDir) {
  let raw = {};
  try {
    raw = readJson(path.join(configDir, CONFIG_FILE));
    if (!isObject(raw)) throw new Error('not a JSON object');
  } catch (error) {
    if (error.code !== 'ENOENT') warn(`ignoring ${CONFIG_FILE} (${error.name}); using defaults`);
    raw = {};
  }
  if (raw.schemaVersion !== undefined && !isSupportedSchema(raw)) {
    warn(`unknown "schemaVersion" in ${CONFIG_FILE}; using defaults`);
    raw = {};
  }
  const modern = isSupportedSchema(raw); // v2 and v3 share every v2 key
  const defaults = presetDefaults(raw.preset);
  const pick = (key, valid, fallback = defaults[key]) => {
    if (raw[key] === undefined) return fallback;
    if (valid(raw[key])) return raw[key];
    warn(`invalid "${key}" in ${CONFIG_FILE}; using default`);
    return fallback;
  };
  const config = {
    schemaVersion: modern ? raw.schemaVersion : 1,
    allowlist: pick('allowlist', isAllowlist),
    bannedModels: pick('bannedModels', isStringList),
    retiredModels: [...RETIRED_MODELS],
    planRestrictedModels: [],
    models: [],
    allowFastModes: false,
  };
  const optional = [['tiers', isObject], ['modelIds', isObject], ['quota', isQuota]];
  if (modern) {
    // Both ban lists apply.
    config.bannedModels = [...new Set([...config.bannedModels, ...pick('userBannedModels', isStringList, [])])];
    config.retiredModels = [...new Set([...RETIRED_MODELS, ...pick('retiredModels', isStringList, [])])];
    config.planRestrictedModels = pick('planRestrictedModels', isStringList, []);
    config.models = pick('models', isModelList, []);
    config.allowFastModes = pick('allowFastModes', isBoolean, false);
    optional.push(['subscriptions', isObject], ['maxParallelBuilders', isCount]);
  }
  if (isV3(raw)) optional.push(['telemetry', isTelemetry], ['preflight', isPreflight], ['catalogOverrides', isToggle]);
  // Optional keys: present only when set to a valid value.
  for (const [key, valid] of optional) {
    const value = pick(key, valid);
    if (value !== undefined) config[key] = value;
  }
  if (isV3(raw) && config.catalogOverrides !== false) {
    const { valid, overrides, errors } = loadCatalogOverrides(configDir);
    if (!valid) warn(`ignoring ${CATALOG_OVERRIDES_FILE} (${errors[0]})`);
    if (overrides.retiredModels) {
      config.retiredModels = [...new Set([...config.retiredModels, ...overrides.retiredModels])];
    }
    // The config's own modelIds win over an alias for the same name.
    if (Object.keys(overrides.aliases ?? {}).length) config.modelIds = { ...overrides.aliases, ...config.modelIds };
  }
  return config;
}

export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Hook payload from stdin; null when absent or unparsable (hooks fail open unless throwOnLimit is set). */
export async function readPayload({ maxBytes = MAX_PAYLOAD_BYTES, throwOnLimit = false } = {}) {
  if (process.stdin.isTTY) return null;
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        process.stdin.destroy();
        const err = new RangeError(`hook input exceeded ${maxBytes} bytes`);
        err.code = 'EPAYLOAD_TOO_LARGE';
        throw err;
      }
      chunks.push(buf);
    }
    const text = Buffer.concat(chunks, total).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'EPAYLOAD_TOO_LARGE') {
      if (throwOnLimit) throw error;
      warn(`ignoring oversized hook input (> ${maxBytes} bytes)`);
      return null;
    }
    warn(`ignoring malformed hook input (${error.name})`);
    return null;
  }
}

/** Case-insensitive property lookup, as PowerShell does it. */
export function prop(object, name) {
  if (!isObject(object)) return undefined;
  if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  const key = Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

/** Why a parsed payload must be blocked: it names a tool but its input is not an object. Else null. */
export function payloadProblem(payload) {
  const tool = prop(payload, 'tool_name');
  if (typeof tool !== 'string' || tool === '') return null;
  const input = prop(payload, 'tool_input');
  return input === undefined || isObject(input) ? null : `tool_input of '${tool}' is not an object`;
}

const FAST_KEY = /fast|speed|servicetier/i;
const FAST_VALUE = /^(true|fast|ultrafast|priority)$/i;
const FAST_DEPTH = 6;

/** True when a tool input asks for a fast or priority mode, as a key or as an {id, value} option pair. */
export function fastModeRequested(input, depth = 1) {
  if (depth > FAST_DEPTH || input === null || typeof input !== 'object') return false;
  const asks = (key, value) => typeof key === 'string' && FAST_KEY.test(key.replace(/[^a-z0-9]/gi, ''))
    && (value === true || (typeof value === 'string' && FAST_VALUE.test(value)));
  if (asks(prop(input, 'id'), prop(input, 'value'))) return true;
  return Object.entries(input).some(([key, value]) => asks(key, value) || fastModeRequested(value, depth + 1));
}

const AVAILABILITY_TTL = 12 * 60 * 60_000;

/** { data, stale } of the availability file; data is null when it is missing or malformed. Never throws. */
export function readAvailability(file, now = Date.now()) {
  try {
    const data = readJson(file);
    if (isObject(data) && data.schemaVersion === 1 && isObject(data.models)) {
      const ttl = data.ttlMs > 0 ? data.ttlMs : AVAILABILITY_TTL;
      return { data, stale: !(now - Date.parse(data.checkedAt) < ttl) };
    }
  } catch {
    // reported as no data
  }
  return { data: null, stale: true };
}

/** The entry restricting provider:model, or null. Takes readAvailability's data (or its whole result). */
export function restrictedBy(availability, provider, model, now = Date.now(), config) {
  const wanted = canonicalProvider(provider);
  if (!wanted || typeof model !== 'string') return null;
  const keys = modelKeys(model, config);
  const models = (availability?.data ?? availability)?.models;
  return Object.entries(isObject(models) ? models : {}).find(([ref, entry]) => {
    const [, host, name] = ref.match(/^([^:]+):(.+)$/) ?? [];
    return name !== undefined && canonicalProvider(host) === wanted && [...modelKeys(name, config)].some((key) => keys.has(key))
      && ['plan-restricted', 'unavailable'].includes(entry?.status)
      // An unreadable "until" keeps the restriction.
      && (entry.until === undefined || !(Date.parse(entry.until) <= now));
  })?.[1] ?? null;
}

/** "provider:model" restricts that hosting only; a bare model restricts every hosting. */
export function isPlanRestricted(refs, provider, model, config) {
  if (!Array.isArray(refs) || typeof model !== 'string') return false;
  const target = canonicalProvider(provider);
  const keys = modelKeys(model, config);
  return refs.some((ref) => {
    if (typeof ref !== 'string') return false;
    const [, host, name] = ref.match(/^([^:]+):(.+)$/) ?? [];
    const hosting = canonicalProvider(host);
    if (hosting && hosting !== target) return false;
    return [...modelKeys(hosting ? name : ref, config)].some((key) => keys.has(key));
  });
}

/** PowerShell-like "$($value)" stringification. */
export function str(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(str).join(' ');
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Resolve a command on PATH. Never searches the current directory (unlike a bare spawn on Windows). */
export function which(name) {
  const windows = process.platform === 'win32';
  const extensions = windows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const file = path.join(dir, name + extension.toLowerCase());
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!windows) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

// Characters cmd.exe leaves alone inside double quotes (no % ! ^ & | < > ").
const CMD_SAFE = /^[\p{L}\p{M}\p{N} _.\-\\/:()[\]{}@+,=~#$']*$/u;

/** The program an npm/pnpm .cmd shim launches, as argv, or null if it cannot be determined. */
export function shimTarget(shim) {
  try {
    const match = fs.readFileSync(shim, 'utf8').match(/"%(?:~dp0|dp0%)\\?([^"%]+)"[ \t]+%\*/);
    if (!match) return null;
    const target = path.join(path.dirname(shim), match[1]);
    if (/\.exe$/i.test(target)) return fs.existsSync(target) ? [target] : null;
    const isNode = /\.[cm]?js$/i.test(target) || /^#!.*\bnode\b/.test(fs.readFileSync(target, 'utf8').slice(0, 200));
    return isNode && fs.existsSync(target) ? [process.execPath, target] : null;
  } catch {
    return null;
  }
}

/**
 * Run an executable without letting a shell interpret its arguments. Windows .cmd shims are
 * unwrapped to their node/exe target; otherwise cmd.exe is used only when no argument has a
 * cmd metacharacter. Returns null when the command was skipped.
 */
export function run(executable, args, options = {}) {
  const spawnOptions = { timeout: 30_000, windowsHide: true, ...options };
  if (!/\.(cmd|bat)$/i.test(executable)) return spawnSync(executable, args, spawnOptions);
  const target = shimTarget(executable);
  if (target) return spawnSync(target[0], [...target.slice(1), ...args], spawnOptions);
  const parts = [executable, ...args];
  if (!parts.every((part) => CMD_SAFE.test(part))) return null;
  const line = parts.map((part) => `"${part}"`).join(' ');
  const shell = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return spawnSync(shell, ['/d', '/v:off', '/s', '/c', `"${line}"`], { ...spawnOptions, windowsVerbatimArguments: true });
}

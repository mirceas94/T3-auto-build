// Shared by the installed hooks (and reused by the installer). Node >=18, node:* only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'auto-build.config.json';
export const COOLDOWN_FILE = 'auto-build-cooldowns.json';
export const AVAILABILITY_FILE = 'auto-build-availability.json';
export const SCHEMA_VERSION = 2;

/** Always blocked: config can add to this list, never shrink it. */
export const RETIRED_MODELS = Object.freeze([
  'gemini-4-argon', 'gemini-3.8-flash', 'claude-4.6', 'claude-4.6-*', 'gpt-5.4', 'gpt-5.4-*', 'gpt-5.5', 'gpt-5.5-*',
]);

export const DEFAULTS = {
  allowlist: {
    Codex: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'],
    Antigravity: ['Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Gemini 4 Carbon'],
    Claude: ['Claude Haiku 5.5', 'Claude Sonnet 5.5', 'Claude Opus 5.5'],
  },
  bannedModels: [],
};

export const warn = (message) => process.stderr.write(`t3-auto-build: ${message}\n`);

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
export const isAllowlist = (v) =>
  isObject(v) && Object.values(v).every(isStringList) && Object.values(v).flat().length > 0;

export const parseJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));
export const readJson = (file) => parseJson(fs.readFileSync(file, 'utf8'));

/** Config dir of an installed hook: <configDir>/hooks/t3-auto-build/<hook>.mjs */
export const configDirOf = (metaUrl) => path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..');

export function displayPath(configDir, file) {
  const isDefault = path.resolve(configDir) === path.resolve(os.homedir(), '.claude');
  const base = isDefault ? '~/.claude' : path.resolve(configDir).replace(/\\/g, '/');
  return `${base}/${file}`;
}

/** Makes a model id and its display name comparable: "claude-sonnet-5-5" == "Claude Sonnet 5.5". */
export const normalizeName = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');

/** 'claude' | 'codex' | 'antigravity' from a model id or display name, else null. */
export function inferProvider(model) {
  if (typeof model !== 'string') return null;
  const family = normalizeName(model).match(/^(claude|gpt|gemini)-[a-z0-9]/)?.[1];
  return { claude: 'claude', gpt: 'codex', gemini: 'antigravity' }[family] ?? null;
}

/** Drops a trailing -YYYYMMDD release date. */
export const normalizeModel = (id) => id.replace(/-\d{8}$/, '');

/** The id a provider CLI takes: config.modelIds first, else the hyphenated name (codex ids keep "."). */
export function cliModelId(provider, displayOrId, config) {
  const ids = config?.modelIds;
  if (isObject(ids) && Object.hasOwn(ids, displayOrId)) return ids[displayOrId];
  const separator = provider?.toLowerCase() === 'codex' ? /[^a-z0-9.]+/g : /[^a-z0-9]+/g;
  return displayOrId.toLowerCase().replace(separator, '-').replace(/^-+|-+$/g, '');
}

/** Comparable forms of a model: date-stripped and normalized, plus its config.modelIds counterpart. */
export function modelKeys(model, config) {
  const key = (name) => normalizeName(normalizeModel(name));
  const keys = new Set([key(model)]);
  for (const [name, id] of Object.entries(config?.modelIds ?? {})) {
    if (typeof id === 'string' && (keys.has(key(name)) || keys.has(key(id)))) keys.add(key(name)).add(key(id));
  }
  return keys;
}

/** True when the model is a retired one; a pattern ending "-*" also covers every "<stem>-..." variant. */
export function matchRetired(model, patterns = RETIRED_MODELS) {
  if (typeof model !== 'string') return false;
  const key = (name) => normalizeName(normalizeModel(name.trim())).replace(/^-+|-+$/g, '');
  const name = key(model);
  return patterns.some((pattern) => {
    const family = pattern.endsWith('-*');
    const stem = key(family ? pattern.slice(0, -2) : pattern);
    return name === stem || (family && name.startsWith(`${stem}-`));
  });
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
  const inferred = inferProvider(name);
  const declared = canon[0] ?? null;
  const provider = declared ?? inferred;
  let entry = null;
  if (name && provider) {
    const keys = modelKeys(name, config);
    const models = Array.isArray(config?.models) ? config.models : [];
    entry = models.find((item) => typeof item?.model === 'string' && canonicalProvider(item.provider) === provider
      && [...modelKeys(item.model, config)].some((key) => keys.has(key))) ?? null;
  }
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
    crossHosted: provider !== inferred && Boolean(entry),
    conflict,
  };
}

/** Banned entries match as substrings of the raw or normalized name; "A/B" bans both A and B. */
export function isBanned(model, bannedModels) {
  const name = model.toLowerCase();
  const normalized = normalizeName(model);
  return bannedModels
    .flatMap((entry) => entry.split('/'))
    .map((term) => term.trim().toLowerCase())
    // A term with no letter or digit normalizes to "-" and would ban nearly everything, so it only matches raw.
    .some((term) => term !== ''
      && (name.includes(term) || (/[\p{L}\p{N}]/u.test(term) && normalized.includes(normalizeName(term)))));
}

/** [provider, models] pairs with banned models removed. */
export function effectiveAllowlist({ allowlist, bannedModels }) {
  return Object.entries(allowlist)
    .map(([provider, models]) => [provider, models.filter((m) => !isBanned(m, bannedModels))])
    .filter(([, models]) => models.length > 0);
}

// Preset files are not installed beside the hooks; each is these providers of DEFAULTS (tests keep them in step).
const PRESET_PROVIDERS = { 'claude-codex': ['Codex', 'Claude'], 'claude-only': ['Claude'] };

function presetDefaults(preset) {
  if (!Object.hasOwn(PRESET_PROVIDERS, preset)) return DEFAULTS;
  const allowlist = Object.fromEntries(PRESET_PROVIDERS[preset].map((name) => [name, DEFAULTS.allowlist[name]]));
  return { ...DEFAULTS, allowlist };
}

export const isV2 = (raw) => raw?.schemaVersion === SCHEMA_VERSION;

const isModelList = (v) => Array.isArray(v) && v.every((m) => isObject(m) && isStringList([m.provider, m.model])
  && (m.pool === undefined || typeof m.pool === 'string')
  && (m.scarceQuota === undefined || typeof m.scarceQuota === 'boolean'));
const isBoolean = (v) => typeof v === 'boolean';
const isCount = (v) => Number.isInteger(v) && v >= 0;

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
  if (raw.schemaVersion !== undefined && !isV2(raw)) {
    warn(`unknown "schemaVersion" in ${CONFIG_FILE}; using defaults`);
    raw = {};
  }
  const v2 = isV2(raw);
  const defaults = presetDefaults(raw.preset);
  const pick = (key, valid, fallback = defaults[key]) => {
    if (raw[key] === undefined) return fallback;
    if (valid(raw[key])) return raw[key];
    warn(`invalid "${key}" in ${CONFIG_FILE}; using default`);
    return fallback;
  };
  const config = {
    schemaVersion: v2 ? SCHEMA_VERSION : 1,
    allowlist: pick('allowlist', isAllowlist),
    bannedModels: pick('bannedModels', isStringList),
    retiredModels: [...RETIRED_MODELS],
    planRestrictedModels: [],
    models: [],
    allowFastModes: false,
  };
  const optional = [['tiers', isObject], ['modelIds', isObject]];
  if (v2) {
    // Both ban lists apply.
    config.bannedModels = [...new Set([...config.bannedModels, ...pick('userBannedModels', isStringList, [])])];
    config.retiredModels = [...new Set([...RETIRED_MODELS, ...pick('retiredModels', isStringList, [])])];
    config.planRestrictedModels = pick('planRestrictedModels', isStringList, []);
    config.models = pick('models', isModelList, []);
    config.allowFastModes = pick('allowFastModes', isBoolean, false);
    optional.push(['subscriptions', isObject], ['maxParallelBuilders', isCount]);
  }
  // Optional keys: present only when set to a valid value.
  for (const [key, valid] of optional) {
    const value = pick(key, valid);
    if (value !== undefined) config[key] = value;
  }
  return config;
}

/** Hook payload from stdin; null when absent or unparsable (hooks fail open). */
export async function readPayload() {
  if (process.stdin.isTTY) return null;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch (error) {
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
function shimTarget(shim) {
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

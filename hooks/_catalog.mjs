// Model catalog shared by the installed hooks and lib/. Node >=18, node:* only.
// _shared.mjs re-exports from here, so this file must not import it.
import fs from 'node:fs';
import path from 'node:path';

export const PROVIDERS = ['claude', 'codex', 'antigravity'];
export const POOLS = ['standard', 'fable', 'astra', 'third-party-claude'];
export const SCARCE_POOL = { claude: 'fable', codex: 'astra', antigravity: 'third-party-claude' };
export const CATALOG_OVERRIDES_FILE = 'catalog.overrides.json';

/** Always blocked: config can add to this list, never shrink it. */
export const RETIRED_MODELS = Object.freeze([
  'gemini-4-argon', 'gemini-3.8-flash', 'claude-4.6', 'claude-4.6-*', 'gpt-5.4', 'gpt-5.4-*', 'gpt-5.5', 'gpt-5.5-*',
]);

export function deepFreeze(value) {
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
  'gpt-6.2-sol': model('codex', 'gpt-sol', '6.2'),
  'gpt-6-astra': model('codex', 'gpt-astra', '6', 'astra'),
  'gpt-6.2-astra': model('codex', 'gpt-astra', '6.2', 'astra'),
  'gpt-5.6-terra': model('codex', 'gpt-terra', '5.6'),
  'gpt-5.6-luna': model('codex', 'gpt-luna', '5.6'),
  'gemini-4-hydrogen': model('antigravity', 'gemini-hydrogen', '4'),
  'gemini-4-neon': model('antigravity', 'gemini-neon', '4'),
  'gemini-4-carbon': model('antigravity', 'gemini-carbon', '4'),
});

/** Catalog ids that draw on a capped pool, per native provider. */
export const HEAVY_MODELS = deepFreeze(Object.fromEntries(PROVIDERS.map((provider) => [
  provider,
  Object.keys(MODELS).filter((id) => MODELS[id].provider === provider && MODELS[id].scarceQuota),
])));

/** What a v1 "tier:<provider>:heavy" cooldown has always locked when the config lists no heavyModels. */
export const LEGACY_HEAVY_MODELS = deepFreeze({
  claude: ['Claude Opus 5.5'], codex: ['gpt-6-luna'], antigravity: ['Gemini 4 Carbon'],
});

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Makes a model id and its display name comparable: "claude-sonnet-5-5" == "Claude Sonnet 5.5". */
export const normalizeName = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');

/** 'claude' | 'codex' | 'antigravity' from a model id or display name, else null. */
export function inferProvider(name) {
  if (typeof name !== 'string') return null;
  const family = normalizeName(name).match(/^(claude|gpt|gemini)-[a-z0-9]/)?.[1];
  return { claude: 'claude', gpt: 'codex', gemini: 'antigravity' }[family] ?? null;
}

/** Drops a trailing -YYYYMMDD release date. */
export const normalizeModel = (id) => id.replace(/-\d{8}$/, '');

const comparable = (name) => normalizeName(normalizeModel(name.trim())).replace(/^-+|-+$/g, '');

/** True when the model is a retired one; a pattern ending "-*" also covers every "<stem>-..." variant. */
export function matchRetired(candidate, patterns = RETIRED_MODELS) {
  if (typeof candidate !== 'string') return false;
  const name = comparable(candidate);
  return patterns.some((pattern) => {
    const family = pattern.endsWith('-*');
    const stem = comparable(family ? pattern.slice(0, -2) : pattern);
    return name === stem || (family && name.startsWith(`${stem}-`));
  });
}

const BUILTIN_BY_KEY = new Map(Object.keys(MODELS).map((id) => [comparable(id), id]));
const nativeProvider = (key) => MODELS[BUILTIN_BY_KEY.get(key)]?.provider ?? inferProvider(key);
const isPlain = (v) => typeof v === 'string' && !/[\p{Cc}]/u.test(v);
const isName = (v) => isPlain(v) && comparable(v) !== '';
const quote = (v) => String(JSON.stringify(v)).slice(0, 80);

const OVERRIDE_KEYS = ['models', 'retiredModels', 'aliases'];
const MODEL_FIELDS = {
  provider: (v) => PROVIDERS.includes(v),
  model: isName,
  pool: (v) => POOLS.includes(v),
  scarceQuota: (v) => typeof v === 'boolean',
  family: isPlain,
  version: isPlain,
  crossHosted: (v) => typeof v === 'boolean',
};
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

function modelErrors(entry, retired) {
  if (!isObject(entry) || !Object.hasOwn(entry, 'provider') || !Object.hasOwn(entry, 'model')) {
    return [`model entry needs "provider" and "model": ${quote(entry)}`];
  }
  const bad = Object.keys(entry).filter((key) => !Object.hasOwn(MODEL_FIELDS, key) || !MODEL_FIELDS[key](entry[key]));
  if (bad.length) return bad.map((key) => `invalid model field ${quote(key)}: ${quote(entry[key])}`);
  if (matchRetired(entry.model, retired)) return [`retired model cannot be added: ${quote(entry.model)}`];
  const native = nativeProvider(comparable(entry.model));
  if (native && native !== entry.provider && entry.crossHosted !== true) {
    return [`model ${quote(entry.model)} is native to ${native}; hosting on ${entry.provider} needs "crossHosted": true`];
  }
  return [];
}

function hasCycle(edges) {
  const next = new Map();
  for (const [from, to] of edges) next.set(from, [...(next.get(from) ?? []), to]);
  const open = new Set();
  const done = new Set();
  const visit = (node) => {
    if (open.has(node)) return true;
    if (done.has(node)) return false;
    open.add(node);
    const found = (next.get(node) ?? []).some(visit);
    open.delete(node);
    done.add(node);
    return found;
  };
  return [...next.keys()].some(visit);
}

function aliasErrors(aliases, retired) {
  if (!isObject(aliases)) return ['"aliases" must be an object'];
  const errors = [];
  const pairs = [];
  for (const [from, to] of Object.entries(aliases)) {
    if (RESERVED_KEYS.includes(from) || !isName(from) || !isName(to)) {
      errors.push(`invalid alias ${quote(from)}: ${quote(to)}`);
    } else if (matchRetired(from, retired) || matchRetired(to, retired)) {
      errors.push(`alias ${quote(from)} involves a retired model`);
    } else pairs.push([from.trim(), to.trim()]);
  }
  const keys = pairs.map((pair) => pair.map(comparable));
  // A display name pointing at its own id ("Claude Opus 5.5" to "claude-opus-5-5") is not a cycle.
  if (hasCycle(pairs) || hasCycle(keys.filter(([from, to]) => from !== to))) errors.push('alias cycle');
  // Aliased names become interchangeable to the guards, so linked names must stay one model of one provider.
  const groups = new Map();
  for (const [from, to] of keys) {
    const merged = new Set([...(groups.get(from) ?? [from]), ...(groups.get(to) ?? [to])]);
    for (const key of merged) groups.set(key, merged);
  }
  for (const group of new Set(groups.values())) {
    const names = [...group];
    const providers = new Set(names.map(nativeProvider).filter(Boolean));
    const builtins = new Set(names.map((key) => BUILTIN_BY_KEY.get(key)).filter(Boolean));
    if (providers.size > 1 || builtins.size > 1) {
      errors.push(`alias spoofs another model or provider: ${quote(names.join(', '))}`);
    }
  }
  return errors;
}

const isCleanList = (v) => isStringList(v) && v.every(isPlain);

/** { valid, overrides, errors }. Any error drops everything except a well-formed retiredModels, which only tightens. */
export function validateCatalogOverrides(raw) {
  const reject = (errors) => ({
    valid: false,
    overrides: isCleanList(raw?.retiredModels) ? { retiredModels: raw.retiredModels } : {},
    errors,
  });
  if (!isObject(raw)) return reject(['overrides must be a JSON object']);
  const errors = Object.keys(raw).filter((key) => !OVERRIDE_KEYS.includes(key)).map((key) => `unknown key ${quote(key)}`);
  const { models, retiredModels, aliases } = raw;
  let retired = RETIRED_MODELS;
  if (retiredModels !== undefined) {
    if (isCleanList(retiredModels)) retired = [...RETIRED_MODELS, ...retiredModels];
    else errors.push('"retiredModels" must be a list of model names');
  }
  if (models !== undefined) {
    if (Array.isArray(models)) errors.push(...models.flatMap((entry) => modelErrors(entry, retired)));
    else errors.push('"models" must be a list');
  }
  if (aliases !== undefined) errors.push(...aliasErrors(aliases, retired));
  return errors.length ? reject(errors) : { valid: true, overrides: { ...raw }, errors };
}

/** Validated <configDir>/catalog.overrides.json; a missing or blank file is valid and empty. Never throws. */
export function loadCatalogOverrides(configDir) {
  try {
    const text = fs.readFileSync(path.join(configDir, CATALOG_OVERRIDES_FILE), 'utf8').replace(/^﻿/, '');
    if (text.trim()) return validateCatalogOverrides(JSON.parse(text));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { valid: false, overrides: {}, errors: [`unreadable (${error.code ?? error.name})`] };
    }
  }
  return { valid: true, overrides: {}, errors: [] };
}

// Tier-1 availability: zero-inference discovery, the cached availability file and model drift. Node >=18, node:* only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AVAILABILITY_FILE, COOLDOWN_FILE, RETIRED_MODELS, canonicalProvider, inferProvider, isBanned, isObject, isStringList,
  matchRetired, modelKeys, normalizeModel, readAvailability, warn, which as findOnPath,
} from '../hooks/_shared.mjs';
import { prune, readCooldowns, writeCooldowns } from '../hooks/_quota.mjs';
import { CliError } from './paths.mjs';
import { MODELS, PROVIDERS, supersedes } from './plans.mjs';
import { probeModels } from './probe.mjs';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_TTL = 30 * UNIT_MS.d;
const CACHE_TTL = 12 * UNIT_MS.h;
const MAX_OUTPUT = 1_000_000;
const STATUSES = ['available', 'plan-restricted', 'unavailable'];
// Adapter output and the availability file are untrusted, and these ids can end up in the config and SKILL.md.
const DISCOVERED_ID = /^(?=.*\d)[a-z0-9][a-z0-9._-]{0,79}$/;
const MARKED_MODEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()[\]-]{0,99}$/u;

/** "30m" | "24h" | "30d" in milliseconds; more than 0 and at most 30 days. */
export function parseTtl(text = '24h') {
  const match = typeof text === 'string' ? text.match(/^(\d+)(m|h|d)$/) : null;
  const ms = match ? Number(match[1]) * UNIT_MS[match[2]] : 0;
  if (!(ms > 0 && ms <= MAX_TTL)) {
    throw new CliError(`invalid ttl "${String(text).slice(0, 20)}"; use <n>m, <n>h or <n>d, up to 30d`, 2);
  }
  return ms;
}

/** { family, version } of a model id or display name, else null. */
export function parseFamily(id) {
  if (typeof id !== 'string') return null;
  const name = normalizeModel(id.trim().toLowerCase().replace(/\s+/g, '-'));
  if (Object.hasOwn(MODELS, name)) return { family: MODELS[name].family, version: MODELS[name].version };
  const other = name.match(/^(gpt|gemini)-(\d+(?:\.\d+)*)-([a-z]+(?:-[a-z]+)*)$/);
  if (other) return { family: `${other[1]}-${other[3]}`, version: other[2] };
  const claude = name.match(/^claude-([a-z]+)-(\d+(?:[.-]\d+)*)$/);
  return claude ? { family: `claude-${claude[1]}`, version: claude[2].replace(/-/g, '.') } : null;
}

const sameModel = (a, b, config) => {
  const keys = modelKeys(a, config);
  return [...modelKeys(b, config)].some((key) => keys.has(key));
};

/** Usable config.models entries, with canonical provider keys. */
const configuredModels = (config) => (Array.isArray(config?.models) ? config.models : [])
  .filter((entry) => isObject(entry) && typeof entry.model === 'string' && canonicalProvider(entry.provider))
  .map((entry) => ({ ...entry, provider: canonicalProvider(entry.provider) }));

const list = (value) => (isStringList(value) ? value : []);
const retiredPatterns = (config) => [...RETIRED_MODELS, ...list(config?.retiredModels)];
const bannedTerms = (config) => [...list(config?.bannedModels), ...list(config?.userBannedModels)];

const failed = (code) => ({ status: null, stdout: '', stderr: '', error: { code } });

// A .cmd shim goes through run() in a node child, which keeps its quoting rules and leaves this process free to kill it.
const SHIM_RUNNER = `const { run } = await import(${JSON.stringify(new URL('../hooks/_shared.mjs', import.meta.url).href)});
const [file, args] = JSON.parse(process.argv[1]);
process.exitCode = run(file, args, { stdio: ['ignore', 'inherit', 'ignore'] })?.status ?? 1;`;

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => child.kill()).unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // the child leads its own process group
  } catch {
    // already gone
  }
}

/** Async counterpart of probe.mjs createRunner: runs in an empty temp directory and kills the tree on timeout. */
const asyncRunner = (which) => (cmd, args, { timeout }) => new Promise((resolve) => {
  const executable = path.isAbsolute(cmd) ? cmd : which(cmd);
  if (!executable) {
    resolve(failed('ENOENT'));
    return;
  }
  const [file, argv] = /\.(cmd|bat)$/i.test(executable)
    ? [process.execPath, ['--input-type=module', '-e', SHIM_RUNNER, JSON.stringify([executable, args])]]
    : [executable, args];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't3-discover-'));
  let timer;
  let stdout = '';
  const finish = (result) => {
    clearTimeout(timer);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // still held by a dying child; the OS temp cleanup takes it
    }
    resolve(result);
  };
  let child;
  try {
    child = spawn(file, argv, {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32',
    });
  } catch (error) {
    finish(failed(error.code));
    return;
  }
  const abort = (code) => {
    killTree(child);
    child.stdout.destroy();
    child.unref();
    finish(failed(code));
  };
  timer = setTimeout(() => abort('ETIMEDOUT'), timeout);
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > MAX_OUTPUT) abort('ENOBUFS');
  });
  child.on('error', (error) => finish(failed(error.code)));
  child.on('close', (status) => finish({ status, stdout, stderr: '' }));
});

/** Never rejects and never takes longer than timeoutMs, whatever the runner does. */
function bounded(work, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(failed('ETIMEDOUT')), timeoutMs); });
  const attempt = Promise.resolve().then(work).catch((error) => failed(error?.code));
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

const succeeded = (result) => result?.status === 0 && !result.error;

const versionIn = (result) => (succeeded(result)
  ? String(result.stdout).slice(0, 500).match(/\d+(?:\.\d+)+(?:-[0-9A-Za-z.]{1,20})?/)?.[0] ?? null
  : null);

/** Model ids from a JSON array or one-per-line output; null when the adapter failed or listed nothing usable. */
function modelIdsIn(result) {
  if (!succeeded(result)) return null;
  const text = String(result.stdout).replace(/^\uFEFF/, '').trim();
  let items = text.split(/\r?\n/);
  if (text.startsWith('[')) {
    try {
      items = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const ids = [...new Set(items.filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => DISCOVERED_ID.test(item)))];
  return ids.length ? ids : null;
}

/** Binary checks and optional listing adapters, in parallel. Never runs inference. */
export async function discover({ config, runner, which = findOnPath, now = Date.now(), timeoutMs = 1500 } = {}) {
  const exec = runner ?? asyncRunner(which);
  const call = (cmd, args) => bounded(() => exec(cmd, args, { timeout: timeoutMs }), timeoutMs);
  // shortcut: no built-in listing adapters, as no CLI documents one; only config.discovery argv. Add one when a CLI does.
  const hosts = await Promise.all(PROVIDERS.map(async (provider) => {
    const found = Boolean(which(provider));
    const argv = config?.discovery?.[provider];
    const [version, listing] = await Promise.all([
      found ? call(provider, ['--version']) : null,
      isStringList(argv) && argv.length > 0 ? call(argv[0], argv.slice(1)) : null,
    ]);
    return { provider, found, version: versionIn(version), listed: modelIdsIn(listing) };
  }));

  const configured = configuredModels(config);
  const checkedAt = new Date(now).toISOString();
  const models = {};
  const discoveredNew = [];
  const missingConfigured = [];
  for (const { provider, listed } of hosts) {
    if (!listed) continue;
    const mine = configured.filter((entry) => entry.provider === provider);
    for (const id of listed) {
      const match = mine.find((entry) => sameModel(entry.model, id, config));
      if (match) {
        models[`${provider}:${match.model}`] = { status: 'available', source: 'discover', checkedAt };
        continue;
      }
      const parsed = parseFamily(id);
      const item = { provider, model: id, family: parsed?.family ?? null, version: parsed?.version ?? null };
      let newest = null;
      for (const entry of parsed ? mine : []) {
        const other = parseFamily(entry.model);
        if (other?.family === parsed.family && (!newest || supersedes(other, newest.parsed))) {
          newest = { model: entry.model, parsed: other };
        }
      }
      if (newest && supersedes(parsed, newest.parsed) && !matchRetired(id, retiredPatterns(config))) {
        item.supersedes = newest.model;
      }
      discoveredNew.push(item);
    }
    // Cross-hosted models are not expected in a provider's own listing.
    missingConfigured.push(...mine
      .filter((entry) => inferProvider(entry.model) === provider
        && !listed.some((id) => sameModel(entry.model, id, config)))
      .map((entry) => `${provider}:${entry.model}`));
  }
  return {
    binaries: Object.fromEntries(hosts.map(({ provider, found, version }) => [provider, { found, version }])),
    models,
    discoveredNew,
    missingConfigured,
  };
}

/** The stored availability data, or null when the file is missing or unusable. */
export function readAvailabilityFile(configDir) {
  return readAvailability(path.join(configDir, AVAILABILITY_FILE)).data;
}

export function writeAvailability(configDir, data) {
  const file = path.join(configDir, AVAILABILITY_FILE);
  const stored = { ...data, schemaVersion: 1 };
  fs.mkdirSync(configDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`);
  fs.renameSync(temp, file);
  return stored;
}

/** Entries without an expired "until"; an unreadable one is kept, as restrictedBy does. */
const unexpired = (models, now) => Object.fromEntries(Object.entries(models ?? {})
  .filter(([, entry]) => isObject(entry) && !(Date.parse(entry.until) <= now)));

/**
 * Stores an entry, replacing every spelling of the same provider:model. A live manual mark beats any other source,
 * and a listing alone never lifts a restriction.
 */
function put(models, provider, model, entry, now) {
  const matches = Object.keys(models).filter((ref) => {
    const [, host, name] = ref.match(/^([^:]+):(.+)$/) ?? [];
    return name !== undefined && canonicalProvider(host) === provider && sameModel(name, model);
  });
  if (entry.source !== 'mark'
    && matches.some((ref) => models[ref].source === 'mark' && Date.parse(models[ref].until) > now)) return;
  if (entry.source === 'discover' && matches.some((ref) => models[ref].status !== 'available')) return;
  for (const ref of matches) delete models[ref];
  models[`${provider}:${model}`] = entry;
}

/** Drops expired locks and adds new ones without ever shortening an existing lock. */
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
  if (added || Object.keys(removed).length > 0) writeCooldowns(file, kept, { remove: Object.keys(removed) });
}

/** Configured models worth spending a probe on, grouped by provider, and the scarce ones left out. */
function probeCandidates(config, probeScarce) {
  const candidates = {};
  const skippedScarce = [];
  for (const { provider, model, scarceQuota } of configuredModels(config)) {
    if (matchRetired(model, retiredPatterns(config)) || isBanned(model, bannedTerms(config))) continue;
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
  configDir, config, refresh = false, probeScarce = false, ttlMs = CACHE_TTL, now = Date.now(), runner, which,
  probe = probeModels,
} = {}) {
  updateCooldowns(configDir, now);
  const found = await discover({ config, runner, which, now });
  const checkedAt = readAvailabilityFile(configDir)?.checkedAt;
  const stale = !(now - Date.parse(checkedAt) <= ttlMs);
  const probing = stale || refresh;
  let results = [];
  let skippedScarce = [];
  if (probing) {
    const selected = probeCandidates(config, probeScarce);
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
  return { availability, probed, skippedScarce, stale };
}

/** Records a manual status for one hosting of a model, effective immediately and until the ttl ends. */
export function markAvailability({ configDir, ref, status, ttl = '24h', reason, now = Date.now() } = {}) {
  const [, host, rest = ''] = String(ref ?? '').match(/^([^:]+):(.*)$/s) ?? [];
  const provider = canonicalProvider(host);
  const model = rest.trim();
  if (!provider || !MARKED_MODEL.test(model)) {
    throw new CliError(`invalid model reference; use <${PROVIDERS.join('|')}>:<model>`, 2);
  }
  if (!STATUSES.includes(status)) throw new CliError(`invalid status; use ${STATUSES.join(', ')}`, 2);
  const note = String(reason ?? '').replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 200);
  const entry = {
    status,
    source: 'mark',
    checkedAt: new Date(now).toISOString(),
    until: new Date(now + parseTtl(ttl)).toISOString(),
    ...(note && { reason: note }),
  };
  // A file created by a mark has never been probed, so it starts out stale.
  const data = readAvailabilityFile(configDir) ?? {
    checkedAt: new Date(0).toISOString(), ttlMs: CACHE_TTL, binaries: {}, models: {}, discoveredNew: [],
    missingConfigured: [],
  };
  const models = unexpired(data.models, now);
  put(models, provider, model, entry, now);
  writeAvailability(configDir, { ...data, models });
  return entry;
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
    if (restricted.includes(model) || restricted.includes(`${provider}:${model}`)) continue;
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

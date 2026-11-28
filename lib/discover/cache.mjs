// The cached availability file: TTLs, reading, atomic writing and manual marks. Node >=18, node:* only.
import path from 'node:path';
import {
  AVAILABILITY_FILE, canonicalProvider, isObject, readAvailability, withFileLock, writeFileAtomic,
} from '../../hooks/_shared.mjs';
import { CliError } from '../paths.mjs';
import { PROVIDERS } from '../plans.mjs';
import { sameModel } from './sources.mjs';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_TTL = 30 * UNIT_MS.d;
export const CACHE_TTL = 12 * UNIT_MS.h;
export const STATUSES = ['available', 'plan-restricted', 'unavailable'];
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

/** The stored availability data, or null when the file is missing or unusable. */
export function readAvailabilityFile(configDir) {
  return readAvailability(path.join(configDir, AVAILABILITY_FILE)).data;
}

function writeAvailabilityUnlocked(file, data) {
  const stored = { ...data, schemaVersion: 1 };
  writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

function withAvailabilityLock(file, action) {
  try {
    return withFileLock(file, action);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === 'ELOCKED') throw new CliError(`${file}: busy (${error.message})`);
    throw error;
  }
}

export function writeAvailability(configDir, data) {
  const file = path.join(configDir, AVAILABILITY_FILE);
  return withAvailabilityLock(file, () => writeAvailabilityUnlocked(file, data));
}

export { writeAvailability as writeAvailabilityFile };

/** Locked read-modify-write; the synchronous updater gets the stored data (or null) and returns what to store. */
export function updateAvailability(configDir, updater) {
  const file = path.join(configDir, AVAILABILITY_FILE);
  return withAvailabilityLock(file, () => writeAvailabilityUnlocked(file, updater(readAvailabilityFile(configDir))));
}

/** Entries without an expired "until"; an unreadable one is kept, as restrictedBy does. */
export const unexpired = (models, now) => Object.fromEntries(Object.entries(models ?? {})
  .filter(([, entry]) => isObject(entry) && !(Date.parse(entry.until) <= now)));

/**
 * Stores an entry, replacing every spelling of the same provider:model. A live manual mark beats any other source,
 * and a listing alone never lifts a restriction.
 */
export function put(models, provider, model, entry, now) {
  const matches = Object.keys(models).filter((ref) => {
    const [, host, name] = ref.match(/^([^:]+):(.+)$/) ?? [];
    return name !== undefined && canonicalProvider(host) === provider && sameModel(name, model);
  });
  if (entry.source !== 'mark'
    && matches.some((ref) => models[ref].source === 'mark' && !(Date.parse(models[ref].until) <= now))) return;
  if (entry.source === 'discover' && matches.some((ref) => models[ref].status !== 'available')) return;
  for (const ref of matches) delete models[ref];
  models[`${provider}:${model}`] = entry;
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
  updateAvailability(configDir, (stored) => {
    // A file created by a mark has never been probed, so it starts out stale.
    const data = stored ?? {
      checkedAt: new Date(0).toISOString(), ttlMs: CACHE_TTL, binaries: {}, models: {}, discoveredNew: [],
      missingConfigured: [],
    };
    const models = unexpired(data.models, now);
    put(models, provider, model, entry, now);
    return { ...data, models };
  });
  return entry;
}

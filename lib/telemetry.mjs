// Local run ledger behind `t3-auto-build trace record` and `stats`. Node >=18, node:* only.
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_FILE, canonicalProvider, isObject, parseJson } from '../hooks/_shared.mjs';
import { CliError, safePath } from './paths.mjs';

const DAY = 86_400_000;
const MAX_BYTES = 1_048_576;
const LEVELS = ['L0', 'L1', 'L2', 'L3'];
const SHAPES = ['A', 'B'];
const EFFORTS = ['low', 'medium', 'high'];
const TEXT_FIELDS = ['step', 'provider', 'model', 'outcome', 'failoverFrom'];

// Ledger text is printed later, so it is kept to one short line without control characters.
const clean = (value) => String(value).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 120);

function pick(value, choices, name) {
  const found = choices.find((choice) => choice.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) throw new CliError(`invalid ${name} "${clean(value)}"; use ${choices.join(', ')}`, 2);
  return found;
}

/** The known fields only, in a fixed order; throws a usage error for anything unusable. */
function sanitize(entry) {
  if (!isObject(entry)) throw new CliError('trace entry must be a JSON object', 2);
  const given = (name) => entry[name] !== undefined && entry[name] !== null && entry[name] !== '';
  const time = given('ts') ? Date.parse(entry.ts) : Date.now();
  if (Number.isNaN(time)) throw new CliError('invalid ts; use an ISO time', 2);
  const out = { ts: new Date(time).toISOString() };
  if (given('level')) out.level = pick(entry.level, LEVELS, 'level');
  if (given('shape')) out.shape = pick(entry.shape, SHAPES, 'shape');
  if (given('effort')) out.effort = pick(entry.effort, EFFORTS, 'effort');
  for (const name of TEXT_FIELDS) {
    if (!given(name)) continue;
    if (typeof entry[name] !== 'string') throw new CliError(`invalid ${name}; use text`, 2);
    const text = clean(entry[name]);
    if (text) out[name] = name === 'provider' ? canonicalProvider(text) ?? text : text;
  }
  if (given('durationMs')) {
    if (!Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0) {
      throw new CliError('invalid duration; use whole milliseconds, 0 or more', 2);
    }
    out.durationMs = entry.durationMs;
  }
  if (!out.step && !out.model && !out.outcome) throw new CliError('trace entry needs a step, model or outcome', 2);
  return out;
}

/** Windows holds files briefly (scanners, other writers), so busy errors are retried a few times. */
function retry(action, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= attempts || !['EBUSY', 'EPERM'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function ledgerPath(configDir) {
  const file = safePath(configDir, LEDGER_FILE);
  if (!file) throw new CliError(`${path.join(configDir, LEDGER_FILE)} is a symlink; refusing to use it`);
  return file;
}

/** Appends one JSONL line, first moving a ledger that would outgrow maxBytes to "<ledger>.1". */
export function recordTrace(configDir, entry, { maxBytes } = {}) {
  const record = sanitize(entry);
  const line = `${JSON.stringify(record)}\n`;
  const file = ledgerPath(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 0 && size + Buffer.byteLength(line) > (maxBytes ?? MAX_BYTES)) {
    // shortcut: unlocked rotation, two writers rotating at once can drop the older ".1"; add a lock file if it matters.
    try {
      retry(() => fs.renameSync(file, `${file}.1`));
    } catch (error) {
      // A rotation that fails must not lose the entry; the next write tries again.
      if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  }
  retry(() => fs.appendFileSync(file, line));
  return record;
}

const countBy = (entries, name) => {
  const counts = new Map();
  for (const entry of entries) {
    if (typeof entry[name] === 'string') counts.set(entry[name], (counts.get(entry[name]) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
};

/**
 * Totals for the last `days` of the current ledger (not the rotated ".1"). An entry with step "run" counts one run;
 * every other entry counts one step.
 */
export function summarizeStats(configDir, { days = 30, now = Date.now() } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(ledgerPath(configDir), 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.code !== 'ENOENT') throw new CliError(`${path.join(configDir, LEDGER_FILE)}: cannot be read (${error.code ?? error.name})`);
  }
  const since = now - days * DAY;
  const entries = text.split('\n').flatMap((line) => {
    try {
      const entry = parseJson(line);
      return isObject(entry) && Date.parse(entry.ts) >= since ? [entry] : [];
    } catch {
      return []; // blank, partial or hand-edited line
    }
  });
  const steps = entries.filter((entry) => entry.step !== 'run');
  const durations = steps.map((entry) => entry.durationMs).filter((ms) => Number.isFinite(ms) && ms >= 0);
  return {
    totalRuns: entries.length - steps.length,
    totalSteps: steps.length,
    byProvider: countBy(steps, 'provider'),
    byModel: countBy(steps, 'model'),
    failovers: entries.filter((entry) => entry.failoverFrom).length,
    auditRejections: entries.filter((entry) => /reject/i.test(String(entry.outcome ?? ''))).length,
    avgDurationMs: durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : 0,
    windowDays: days,
  };
}

export function formatStats(stats) {
  const counts = (map) => Object.entries(map).map(([name, count]) => `${clean(name)} ${count}`).join(', ') || 'none';
  return [
    `last ${stats.windowDays}d: ${stats.totalRuns} runs, ${stats.totalSteps} steps, avg ${(stats.avgDurationMs / 1000).toFixed(1)}s/step`,
    `failovers ${stats.failovers}; audit rejections ${stats.auditRejections}`,
    `providers: ${counts(stats.byProvider)}`,
    `models: ${counts(stats.byModel)}`,
  ].join('\n');
}

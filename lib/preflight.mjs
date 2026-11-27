// Deterministic Step 0 behind `t3-auto-build preflight`: availability, locks, ladders, baseline and resume state.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE, COOLDOWN_FILE, canonicalProvider, effectiveAllowlist, inferProvider, isObject, isPlanRestricted,
  loadConfig, matchRetired, normalizeName, readJson, resolveTarget, restrictedBy, run, which,
} from '../hooks/_shared.mjs';
import { isLocked, prune, readCooldowns } from '../hooks/_quota.mjs';
import { checkModels } from './discover.mjs';
import { completeConfig } from './install.mjs';
import { fileHash } from './manifest.mjs';
import { CliError } from './paths.mjs';
import { LADDERS } from './render.mjs';

const TTL = 43_200_000;
const STATE_FIELDS = ['flags', 'completedWaves', 'modifiedFiles', 'remaining', 'blockers'];

// Cooldown and state file text ends up in the session context, so it is printed as one short line.
const clean = (text, max = 120) => String(text).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').slice(0, max);

function readRawConfig(file) {
  let raw;
  try {
    raw = readJson(file);
  } catch (error) {
    throw new CliError(`${file}: cannot read valid config JSON (${error.code ?? error.name})`);
  }
  if (!isObject(raw)) throw new CliError(`${file}: not a JSON object`);
  return raw;
}

/** Unlike check-models, an unreadable lock file stops the run: reporting "no locks" would be wrong. */
function activeCooldowns(configDir, now) {
  const file = path.join(configDir, COOLDOWN_FILE);
  try {
    return prune(readCooldowns(file), now).kept;
  } catch (error) {
    throw new CliError(`${file}: cannot be read (${error.code ?? error.name}); fix it or run quota clear --all`);
  }
}

/** Providers named by --<provider>-only flags (same spelling as the rendered skill), as canonical keys. */
function onlyProviders(tokens, config) {
  const names = [...Object.keys(config.allowlist), 'Claude', 'Codex', 'Antigravity'];
  return new Set(names
    .filter((name) => tokens.includes(`--${name.toLowerCase().replace(/\s+/g, '-')}-only`))
    .map((name) => canonicalProvider(name) ?? name));
}

/** Every ladder minus what this run may not use, scarce pools last. An exhausted ladder stays empty. */
function resolveLadders({ ladders, config, availability, cooldowns, only, now }) {
  const groups = effectiveAllowlist(config).map(([group, models]) =>
    [canonicalProvider(group) ?? group, new Set(models.map(normalizeName))]);
  return Object.fromEntries(LADDERS.map((slot) => {
    const entries = (Array.isArray(ladders?.[slot]) ? ladders[slot] : []).flatMap((ref) => {
      if (typeof ref !== 'string') return [];
      const name = ref.split('@')[0].trim();
      const colon = name.indexOf(':');
      const model = name.slice(colon + 1);
      const hosted = ([, models]) => models.has(normalizeName(model));
      const provider = colon >= 0
        ? canonicalProvider(name.slice(0, colon))
        : inferProvider(model) ?? groups.find(hosted)?.[0];
      // A bare name may sit in any group, as in renderSkill; a qualified one only in its provider's group.
      const allowed = provider && groups.some((group) => (colon < 0 || group[0] === provider) && hosted(group));
      if (!allowed || (only.size && !only.has(provider))
        || matchRetired(model, config.retiredModels)
        || isPlanRestricted(config.planRestrictedModels, provider, model, config)
        || restrictedBy(availability, provider, model, now, config)
        || isLocked(cooldowns, { provider, model, config }, now)) return [];
      return [{ ref, scarce: resolveTarget({ providers: [provider], model }, config).scarceQuota }];
    });
    return [slot, entries.sort((a, b) => Number(a.scarce) - Number(b.scarce)).map((entry) => entry.ref)];
  }));
}

/** `git status --short` lines, or [] outside a repository or without git. */
function gitBaseline(cwd) {
  const git = which('git');
  if (!git) return [];
  const result = run(git, ['-C', cwd, 'status', '--short'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 15_000,
  });
  // No trim: a leading space is part of the status code.
  return result?.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** null without a state file, else { valid: true, file, state } or { valid: false, file, error }. */
function resumeState(cwd) {
  const file = path.join(cwd, '.claude', 'auto-build-state.json');
  const invalid = (error) => ({ valid: false, file, error });
  let state;
  try {
    state = readJson(file);
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : invalid(`unreadable (${error.code ?? error.name})`);
  }
  if (!isObject(state)) return invalid('not a JSON object');
  const bad = STATE_FIELDS.filter((name) => state[name] !== undefined && !Array.isArray(state[name]));
  if (bad.length) return invalid(`non-array field(s): ${bad.join(', ')}`);
  // A field the writer left out is an empty list.
  return { valid: true, file, state: { ...Object.fromEntries(STATE_FIELDS.map((name) => [name, []])), ...state } };
}

export async function runPreflight({
  configDir, cwd = process.cwd(), flags = '', refresh = false, now = Date.now(), runner, which: find, probe,
} = {}) {
  const configPath = path.join(configDir, CONFIG_FILE);
  const raw = readRawConfig(configPath);
  // Fail on an unreadable lock file before any probe: checkModels would treat it as "no locks".
  activeCooldowns(configDir, now);
  // checkModels prunes expired locks and probes only when its cache is stale or refresh is set.
  const checked = await checkModels({ configDir, config: raw, refresh, now, runner, which: find, probe });
  // The guard hooks' view of the config; ladders are not part of it.
  const config = loadConfig(configDir);
  const cooldowns = activeCooldowns(configDir, now);
  const tokens = String(flags).split(/\s+/).filter(Boolean);
  const only = onlyProviders(tokens, config);
  const locks = Object.entries(cooldowns).map(([key, { scope, window, until, reason }]) =>
    ({ key: clean(key), scope, window, until, reason: clean(reason) }));
  const canaries = checked.rechecked
    .filter((item) => item.result === 'via-t3' && !tokens.includes('--dry-run') && (!only.size || only.has(item.provider)))
    .map(({ key, provider, model }) => ({
      key,
      provider,
      model,
      until: cooldowns[key]?.until,
      // `quota clear provider:<p>` also drops the pool locks, so they are listed for restoring.
      poolLocks: locks.filter((lock) => lock.key.toLowerCase().startsWith(`tier:${provider}:`))
        .map(({ key: poolKey, until }) => ({ key: poolKey, until })),
    }));
  // The result goes stale at its ttl, or earlier when a lock or an availability restriction lifts.
  const changes = [...locks, ...Object.values(checked.availability.models)]
    .map((entry) => Date.parse(entry.until)).filter((time) => time > now);
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + (config.preflight?.ttl ?? TTL), ...changes)).toISOString(),
    configHash: fileHash(configPath),
    subscriptions: config.subscriptions ?? null,
    locks,
    ladders: resolveLadders({
      ladders: completeConfig(raw).ladders, config, availability: checked.availability, cooldowns, only, now,
    }),
    canaries,
    baseline: gitBaseline(cwd),
    resume: resumeState(cwd),
  };
}

const LIST_LIMIT = 20;

export function formatPreflight(result) {
  const subscriptions = result.subscriptions
    ? Object.entries(result.subscriptions).map(([provider, tier]) => `${clean(provider)}: ${clean(tier)}`).join(', ')
    : 'legacy v1 config (run t3-auto-build upgrade)';
  const lines = [
    `preflight ${result.generatedAt} (expires ${result.expiresAt})`,
    `subscriptions: ${subscriptions}`,
    `locks: ${result.locks.length || 'none'}`,
    ...result.locks.map((lock) => `  ${lock.key} until ${lock.until} (${lock.reason})`),
    'ladders:',
    ...Object.entries(result.ladders).map(([slot, refs]) => `  ${clean(slot)}: ${refs.map((ref) => clean(ref)).join(' -> ') || '(exhausted)'}`),
    ...result.canaries.map((canary) => `recheck-via-t3: ${clean(canary.provider)} (${clean(canary.model)})`),
    `baseline: ${result.baseline.length ? `${result.baseline.length} changed` : 'clean or not a git repo'}`,
    ...result.baseline.slice(0, LIST_LIMIT).map((line) => `  ${clean(line, 200)}`),
    ...(result.baseline.length > LIST_LIMIT ? [`  +${result.baseline.length - LIST_LIMIT} more`] : []),
  ];
  const { resume } = result;
  if (!resume) lines.push('resume: no state file');
  else if (!resume.valid) lines.push(`resume: invalid state file (${resume.error})`);
  else {
    const { completedWaves, remaining, blockers } = resume.state;
    lines.push(`resume: ${completedWaves.length} waves done, ${remaining.length} remaining, ${blockers.length} blockers (${resume.file})`);
  }
  return lines.join('\n');
}

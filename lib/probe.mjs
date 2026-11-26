// Live model probes through the official CLIs, and syncing the allowlist to the result. Node >=18, node:* only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalProvider, CONFIG_FILE, COOLDOWN_FILE, cliModelId, effectiveAllowlist, isBanned, isObject, isStringList,
  readJson, resolveTarget, run, which as findOnPath,
} from '../hooks/_shared.mjs';
import { isLocked, parseRateLimit, readCooldowns, writeCooldowns } from '../hooks/_quota.mjs';
import { HEAVY_MODELS } from './detect.mjs';
import { CliError, PACKAGE_ROOT } from './paths.mjs';
import { completeConfig, configProblem, syncConfig } from './install.mjs';
import { LADDERS } from './render.mjs';

const TIMEOUT = 20_000;

// Flags confirmed by `claude --help` and `codex exec --help`: one-word prompt, no tools or writes, nothing saved.
// There is no documented Antigravity probe. The prompt has no spaces so it survives a cmd.exe shim.
export const PROBES = {
  claude: (id) => ['-p', 'ok', '--model', id, '--tools', '', '--safe-mode', '--no-session-persistence', '--output-format', 'text'],
  codex: (id) => ['exec', '--model', id, '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
    '--ignore-user-config', '--ignore-rules', '--color', 'never', 'ok'],
};

/** Runs a CLI from PATH in an empty temp directory (no project context) with stdin closed. */
export const createRunner = (which = findOnPath) => (cmd, args, { timeout = TIMEOUT } = {}) => {
  const failed = (code) => ({ status: null, stdout: '', stderr: '', error: { code } });
  const executable = which(cmd);
  if (!executable) return failed('ENOENT');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't3-probe-'));
  try {
    // shortcut: a timeout kills only the direct child; kill the process tree if CLIs are seen to linger.
    const res = run(executable, args, { cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (!res) return failed('EUNSAFE');
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // still held by a dying child; the OS temp cleanup takes it
    }
  }
};

const NOT_LOGGED_IN = /not (?:logged|signed) in|not authenticated|please (?:run )?[`'"]?(?:\/login|(?:claude |codex )?(?:auth )?log ?in)|(?:login|authentication) (?:is )?required|authentication[ _](?:failed|error)|invalid (?:api key|x-api-key|authentication)|token (?:has )?expired|\b401\b/i;
const RATE_LIMITED = /\b429\b|rate[\s_-]*limit|(?:usage|session|weekly)[\s_-]*limit|hit your limit|limit reached|too many requests|quota (?:exceeded|exhausted)/i;
// Kept model-specific: a match removes the model from the allowlist.
const PLAN_RESTRICTED = /not (?:available|included|supported|enabled) (?:on|in|with|for) (?:your|this)(?: current)? (?:plan|subscription|account)|(?:not|n't) have access|no access to (?:this |the )?model|unauthorized (?:for (?:this )?)?model|(?:unknown|invalid|unsupported) model|model[ _]not[ _]found|issue with the selected model|model\b[^\n]{0,80}?(?:does not exist|is not supported|not found|not available on)/i;

/** { state: available | rate-limited | plan-restricted | unavailable, reason }; reasons never quote CLI output. */
export function classify(res, { timeout = TIMEOUT } = {}) {
  const result = (state, reason) => ({ state, reason });
  const unavailable = (reason) => result('unavailable', reason);
  if (!res) return unavailable('command could not be run safely');
  const code = res.error?.code;
  if (code === 'ENOENT') return unavailable('cli not found');
  if (code === 'ETIMEDOUT') return unavailable(`timed out after ${timeout / 1000}s`);
  if (code === 'EUNSAFE') return unavailable('command could not be run safely');
  // A successful reply is free text, so its words are never matched.
  if (res.status === 0 && !res.error) return result('available', 'ok');
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  if (NOT_LOGGED_IN.test(text)) return unavailable('not logged in');
  if (RATE_LIMITED.test(text)) return result('rate-limited', 'rate limited');
  if (PLAN_RESTRICTED.test(text)) return result('plan-restricted', 'not available on this plan');
  return unavailable(Number.isInteger(res.status) ? `probe failed (exit ${res.status})` : 'probe failed');
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const has = (list, name) => list.some((item) => same(item, name));
const wantedProviders = (providers) => {
  if (!providers?.length) return () => true;
  const names = [providers].flat().flatMap((p) => p.split(',')).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const unknown = names.find((name) => !Object.hasOwn(HEAVY_MODELS, name));
  if (unknown) throw new CliError(`unknown provider "${unknown}"; use ${Object.keys(HEAVY_MODELS).join(', ')}`, 2);
  return (key) => names.includes(key.toLowerCase());
};

function cooldownFor(provider, model, id, text, config, now) {
  const tier = config.tiers?.[provider];
  const limit = parseRateLimit(text, { now, sharing: tier?.sharing, resetDay: tier?.resetDay });
  const target = resolveTarget({ providers: [provider], model }, config);
  let { scope } = limit;
  let pool = 'heavy';
  if (target.pool !== 'standard') {
    // A capped pool has its own quota: its limit must not lock the rest of the provider.
    pool = target.pool;
    if (scope !== 'model') scope = 'tier';
  } else if (scope === 'tier') {
    // A heavy-tier lock would not cover a light model that was just refused, so lock that model itself.
    const heavy = { [`tier:${provider}:heavy`]: { until: limit.until } };
    if (!isLocked(heavy, { provider, model, config }, now)) scope = 'model';
  }
  // A v2 entry names the hosting that refused, so the same model hosted elsewhere stays usable.
  const modelKey = target.entry ? `model:${provider}:${id}` : `model:${id}`;
  const key = { model: modelKey, provider: `provider:${provider}`, tier: `tier:${provider}:${pool}` }[scope];
  const entry = {
    scope, window: limit.window, until: limit.until, reason: `rate limited (${limit.window})`, source: 'probe',
    ...(scope === 'tier' && { tier: pool }),
  };
  return { key, entry };
}

/** Why a model is left unprobed (its quota is not to be spent), else null. */
function skipReason(provider, model, config, pools, probeScarce) {
  const { pool, scarceQuota } = resolveTarget({ providers: [provider], model }, config);
  if (scarceQuota && !probeScarce) return 'skipped: scarce quota (use --probe-scarce)';
  return pools && !pools.includes(pool) ? 'skipped: pool not selected' : null;
}

/**
 * Probes each candidate model in turn. candidates: { providerKey: [display names] }, default config.allowlist.
 * pools limits probing to those pools; scarceQuota models are reported as skipped unless probeScarce.
 */
export async function probeModels({
  config, candidates, providers, runner, which = findOnPath, now = Date.now(), log = () => {}, pools,
  probeScarce = false,
} = {}) {
  const exec = runner ?? createRunner(which);
  const wanted = wantedProviders(providers);
  const results = [];
  for (const [provider, models] of Object.entries(candidates ?? config.allowlist)) {
    if (!wanted(provider)) continue;
    const name = provider.toLowerCase();
    let providerLimited = false;
    for (const model of models) {
      if (isBanned(model, config.bannedModels ?? [])) continue;
      let outcome;
      const skip = skipReason(name, model, config, pools, probeScarce);
      if (skip) {
        outcome = { state: 'unavailable', reason: skip, skipped: true };
      } else if (!Object.hasOwn(PROBES, name)) {
        outcome = { state: 'unavailable', reason: 'probe not supported' };
      } else if (providerLimited) {
        outcome = { state: 'rate-limited', reason: 'skipped: provider is rate limited', skipped: true };
      } else {
        const id = cliModelId(name, model, config);
        if (typeof id !== 'string' || !/^[a-z0-9][\w.:/[\]-]*$/i.test(id)) {
          outcome = { state: 'unavailable', reason: 'invalid model id' };
        } else {
          const res = await exec(name, PROBES[name](id), { timeout: TIMEOUT });
          outcome = classify(res);
          if (outcome.state === 'rate-limited') {
            outcome.cooldown = cooldownFor(name, model, id, `${res.stdout ?? ''}\n${res.stderr ?? ''}`, config, now);
            providerLimited = outcome.cooldown.entry.scope === 'provider';
          }
        }
      }
      results.push({ provider, model, ...outcome });
      log(`${provider} ${model}: ${outcome.state} (${outcome.reason})`);
    }
  }
  return { results };
}

const isModelMap = (v) => isObject(v) && Object.values(v).every(isStringList);

function readConfig(file) {
  let config;
  try {
    config = readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new CliError(`${file} not found; run the installer first`);
    // The parser message can quote file content, so only the error name is shown.
    throw new CliError(`${file}: cannot be read (${error.code ?? error.name})`);
  }
  if (!isObject(config)) throw new CliError(`${file}: not a JSON object`);
  for (const key of ['allowlist', 'planRestricted']) {
    if (config[key] !== undefined && !isModelMap(config[key])) {
      throw new CliError(`${file}: "${key}" must map provider names to lists of model names`);
    }
  }
  if (config.bannedModels !== undefined && !isStringList(config.bannedModels)) {
    throw new CliError(`${file}: "bannedModels" must be a list of model names`);
  }
  if (config.ladders !== undefined && !(isObject(config.ladders) && Object.values(config.ladders).every(isStringList))) {
    throw new CliError(`${file}: "ladders" must map ladder names to lists`);
  }
  return config;
}

/** Union of provider->models maps; provider and model names compare case-insensitively, first spelling wins. */
function mergeModelMaps(...maps) {
  const merged = {};
  for (const [provider, models] of maps.flatMap((map) => Object.entries(map ?? {}))) {
    const key = Object.keys(merged).find((name) => same(name, provider)) ?? provider;
    merged[key] ??= [];
    for (const model of models) if (!has(merged[key], model)) merged[key].push(model);
  }
  return merged;
}

/** New config for the probe results: unavailable and unprobed models keep their membership. */
function applyResults(config, preset, results) {
  const allowlist = mergeModelMaps(config.allowlist ?? preset.allowlist);
  const restricted = mergeModelMaps(config.planRestricted);
  const keyIn = (map, provider) => Object.keys(map).find((name) => same(name, provider)) ?? provider;
  for (const { provider, model, state, skipped } of results) {
    if (state === 'unavailable') continue;
    const allowKey = keyIn(allowlist, provider);
    const restrictKey = keyIn(restricted, provider);
    const wasRestricted = has(restricted[restrictKey] ?? [], model);
    if (state === 'plan-restricted') {
      if (allowlist[allowKey]) allowlist[allowKey] = allowlist[allowKey].filter((m) => !same(m, model));
      if (!wasRestricted) (restricted[restrictKey] ??= []).push(model);
    } else if (!(skipped && wasRestricted)) { // a model never actually probed does not lift its restriction
      if (!has(allowlist[allowKey] ??= [], model)) allowlist[allowKey].push(model);
      if (wasRestricted) restricted[restrictKey] = restricted[restrictKey].filter((m) => !same(m, model));
    }
  }
  const planRestricted = Object.fromEntries(Object.entries(restricted).filter(([, models]) => models.length > 0));
  const next = { ...config, allowlist };
  if (config.schemaVersion === 2) {
    // v2 restrictions are only added here, never lifted by a probe (tier-derived ones must stay).
    const refs = Object.entries(planRestricted)
      .flatMap(([provider, models]) => models.map((m) => `${canonicalProvider(provider) ?? provider.toLowerCase()}:${m}`));
    next.planRestrictedModels = [...new Set([...(config.planRestrictedModels ?? []), ...refs])];
    return { next, planRestricted };
  }
  if (config.planRestricted !== undefined || Object.keys(planRestricted).length > 0) next.planRestricted = planRestricted;
  return { next, planRestricted };
}

/** Gives every ladder at least one allowed model, so renderSkill cannot fail after removals. */
function backfillLadders(next, preset) {
  const allowed = effectiveAllowlist({ allowlist: next.allowlist, bannedModels: next.bannedModels ?? preset.bannedModels })
    .flatMap(([, models]) => models);
  const fallback = allowed.find((m) => same(m, next.defaultModel ?? preset.defaultModel)) ?? allowed[0];
  for (const name of LADDERS) {
    const ladder = next.ladders?.[name] ?? preset.ladders[name] ?? [];
    if (!ladder.some((entry) => has(allowed, entry.split('@')[0].trim()))) {
      next.ladders = { ...next.ladders, [name]: [...ladder, fallback] };
    }
  }
}

/** Probes the candidate models of <target>'s config and persists the allowlist, cooldowns and SKILL.md. */
export async function syncModels(target, {
  providers, dryRun = false, yes = false, force = false, runner, which, now = Date.now(), log = console.log,
  confirm = async () => false, syncFiles = syncConfig, probeScarce = false,
} = {}) {
  const config = readConfig(path.join(target, CONFIG_FILE));
  const presetName = ['claude-codex', 'claude-only'].includes(config.preset) ? config.preset : 'tri-provider';
  const preset = readJson(path.join(PACKAGE_ROOT, 'presets', `${presetName}.json`));
  const bannedModels = config.bannedModels ?? preset.bannedModels;
  // Checked before probing, so quota is not spent on a config that cannot be saved.
  const problem = configProblem(completeConfig(config));
  if (problem) throw new CliError(`${CONFIG_FILE}: ${problem}`);
  // v2 allowlists are bound to the subscription tier, so the preset roster is never merged in.
  const candidates = config.schemaVersion === 2
    ? mergeModelMaps(config.allowlist)
    : mergeModelMaps(config.allowlist ?? preset.allowlist, config.planRestricted, preset.allowlist);
  const { results } = await probeModels({
    config: { ...config, bannedModels }, candidates, providers, runner, which, now, log, probeScarce,
  });

  const { next, planRestricted } = applyResults(config, preset, results);
  if (effectiveAllowlist({ allowlist: next.allowlist, bannedModels }).length === 0) {
    throw new CliError('no allowed model would remain; nothing was written. Log in with the official CLI, '
      + 'or limit the check with --providers');
  }
  backfillLadders(next, preset);

  const cooldowns = {};
  for (const r of results) {
    if (!r.cooldown) continue;
    const { key, entry } = r.cooldown;
    if (!(Date.parse(cooldowns[key]?.until) >= Date.parse(entry.until))) cooldowns[key] = entry;
  }
  const changed = !isDeepStrictEqual(next, config);
  const summary = { allowlist: next.allowlist, planRestricted, results, cooldowns, changed };
  if (dryRun) return summary;
  if (!yes && !(await confirm(summary))) return { ...summary, changed: false };

  const cooldownFile = path.join(target, COOLDOWN_FILE);
  let stored;
  try {
    stored = readCooldowns(cooldownFile); // read before any write, so a broken file stops the whole sync
  } catch (error) {
    throw new CliError(`${cooldownFile}: cannot be read (${error.code ?? error.name}); fix or delete it`);
  }
  await syncFiles(target, next, { force, log });
  if (Object.keys(cooldowns).length > 0) {
    // An existing lock that lasts longer is never shortened.
    const longer = Object.entries(cooldowns)
      .filter(([key, { until }]) => !(Date.parse(stored[key]?.until) >= Date.parse(until)));
    writeCooldowns(cooldownFile, { ...stored, ...Object.fromEntries(longer) }, { now });
  }
  return summary;
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HEAVY_MODELS } from '../lib/detect.mjs';
import { doctor } from '../lib/doctor.mjs';
import { applyDrift, checkModels, markAvailability, readAvailabilityFile } from '../lib/discover.mjs';
import { PRESETS, install, syncConfig, uninstall, upgrade, wantsAuto } from '../lib/install.mjs';
import { MODULES, readManifest } from '../lib/manifest.mjs';
import { parseSkillTargets } from '../lib/mirrors.mjs';
import { CliError, PACKAGE_VERSION, resolveTarget } from '../lib/paths.mjs';
import { syncModels } from '../lib/probe.mjs';
import { CATALOG, PROVIDERS } from '../lib/plans.mjs';
import { formatPreflight, runPreflight } from '../lib/preflight.mjs';
import { confirmYes, initPrompts, parseChoice, parsePercent, parseTierSpec, TIER_FLAGS } from '../lib/prompt.mjs';
import { QUOTA_WINDOWS, quotaCheck, quotaClear, quotaSet, quotaStatus } from '../lib/quota.mjs';
import { REF_TOPICS, getReference } from '../lib/ref.mjs';
import { formatStats, recordTrace, summarizeStats } from '../lib/telemetry.mjs';
import { AVAILABILITY_FILE, CONFIG_FILE, loadConfig, parseJson, readAvailability, readJson } from '../hooks/_shared.mjs';

const USAGE = `Usage: t3-auto-build <command> [options]

Commands:
  init                         install or update (interactive unless --yes)
  upgrade [--yes]              convert a legacy v1 or v2 config to v3
  check-models                  inspect availability and model drift (cached probes)
  sync-models                   probe and sync models, or apply discovered drift
  availability mark <ref> <status> [--ttl 24h] [--reason <text>]
  availability status          show cache age, model status, and discovered drift
  quota set <subject>          lock a provider/model, or a model pool with --pool
  quota status                 show active locks and drop expired ones
  quota clear [subject]        remove locks of a provider/model (or --all)
  quota check [subject]        read remaining quota of a provider or provider:model
  preflight                    check models, then print locks, ladders, baseline and resume state
  ref <topic>                  print reference text: ${REF_TOPICS.join(' | ')}
  trace record [json]          append one step to the run ledger (JSON or field flags)
  stats                        summarize the run ledger
  doctor                       check installation, tiers, cache, and drift
  uninstall                    remove what init installed, keeping your edits

Global flags:
  --target <dir>               config dir (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  -h, --help                   show this help; -v, --version prints version
  --yes                        do not prompt

init only:
  --preset <name>              ${PRESETS.join(' | ')}
  --modules <name>             ${MODULES.join(' | ')}
  --compaction <n>             auto-compaction threshold, 1-100
  --tiers <list>               legacy provider:plan[:weekday] list
  --claude-tier <tier>         ${Object.keys(CATALOG.claude).join(' | ')}
  --codex-tier <tier>          ${Object.keys(CATALOG.codex).join(' | ')}
  --antigravity-tier <tier>    ${Object.keys(CATALOG.antigravity).join(' | ')}
  --parent <model>             sonnet | opus | fable
  --allow-usage-credits        allow tiers billed per token
  --allow-fast-modes           permit fast/priority service modes
  --verified-org               mark the account as verified organization
  --skill-targets <mode|list>  auto | none | comma-separated skill roots to mirror SKILL.md
  --probe                      run sync-models after installing

check-models only:
  --refresh                    ignore the probe cache TTL
  --probe-scarce               also probe scarce quota models
  --recheck-locks              retest every active provider lock now
  --json                       print machine-readable results

sync-models only:
  --auto                       run without confirmation
  --refresh                    ignore the probe cache TTL
  --probe-scarce               also probe scarce quota models
  --apply                      promote newer known models from discovered drift
  --dry-run                    probe but do not write the synced allowlist
  --providers <list>           only these providers, comma separated
  --force                      replace edited managed SKILL.md after backup

availability only:
  --ttl <duration>             mark lifetime: 1m..30d (default 24h)
  --reason <text>              note shown in availability status

quota set only:
  --pool <name>                lock a model pool (standard, fable, astra, third-party-claude)
  --burst | --5h | --weekly    lock window (default burst)
  --until <when>               ISO time or duration such as 90m or 1w2d
  --reason <text>              note shown by quota status
quota clear flag: --all        remove every lock

quota check only:
  --refresh                    ignore the quota cache TTL
  --on-error                   after a quota error: re-read, then answer retry or failover (needs a subject)
  --claude-usage               also read Claude usage (creates Claude session directories)
  --json                       print machine-readable results

preflight only:
  --flags <text>               inline run flags, e.g. "--codex-only --dry-run"
  --cwd <dir>                  project dir (default: current dir)
  --refresh                    ignore the probe cache TTL
  --json                       print machine-readable results

trace record only (instead of a JSON argument):
  --step <name>                step name; "run" counts one run in stats
  --model <model>              model that ran the step
  --provider <name>            provider that ran the step
  --outcome <text>             result; text containing "reject" counts as an audit rejection
  --level <L0|L1|L2|L3>        complexity level
  --shape <A|B>                work shape
  --effort <level>             low | medium | high
  --duration <ms>              step duration in milliseconds

stats only:
  --days <n>                   window in days (default 30)
  --json                       print machine-readable results

doctor only:
  --fix                        repair what can be repaired (--yes skips the prompt)
  --cwd <dir>                  project dir to check

Examples:
  t3-auto-build init --claude-tier pro --codex-tier plus --antigravity-tier pro --parent opus
  t3-auto-build check-models --json
  t3-auto-build preflight --json --flags "--codex-only"
  t3-auto-build trace record --step build --model gpt-6.1-sol --outcome ok --duration 42000
  t3-auto-build sync-models --refresh --probe-scarce
  t3-auto-build availability mark antigravity:claude-opus-5-5 plan-restricted --ttl 24h
  t3-auto-build quota set antigravity:claude-opus-5-5 --pool third-party-claude
  Overflow to cross-hosted models requires an explicit provider, e.g. antigravity:claude-opus-5-5.`;

const VALUE_FLAGS = ['target', 'preset', 'modules', 'compaction', 'tiers', 'providers', 'until', 'reason', 'parent', 'claude-tier', 'codex-tier', 'antigravity-tier', 'ttl', 'pool', 'skill-targets', 'flags', 'cwd', 'days', 'step', 'model', 'provider', 'outcome', 'level', 'shape', 'effort', 'duration'];
const SWITCHES = ['yes', 'force', 'help', 'version', 'probe', 'dry-run', 'all', 'auto', 'refresh', 'probe-scarce', 'recheck-locks', 'apply', 'json', 'allow-usage-credits', 'allow-fast-modes', 'verified-org', 'fix', 'on-error', 'claude-usage', ...QUOTA_WINDOWS];
const TRACE_FLAGS = ['step', 'model', 'provider', 'outcome', 'level', 'shape', 'effort', 'duration'];
const COMMAND_FLAGS = {
  init: ['preset', 'modules', 'compaction', 'tiers', 'probe', 'yes', 'force', ...Object.values(TIER_FLAGS).map((f) => f.slice(2)), 'parent', 'allow-usage-credits', 'allow-fast-modes', 'verified-org', 'skill-targets'],
  upgrade: ['yes'], doctor: ['fix', 'yes', 'cwd'], uninstall: [],
  preflight: ['json', 'flags', 'cwd', 'refresh'], ref: [], 'trace record': TRACE_FLAGS, stats: ['days', 'json'],
  'check-models': ['refresh', 'probe-scarce', 'recheck-locks', 'json'],
  'sync-models': ['dry-run', 'providers', 'yes', 'auto', 'force', 'refresh', 'probe-scarce', 'apply'],
  'availability mark': ['ttl', 'reason'], 'availability status': [],
  'quota set': [...QUOTA_WINDOWS, 'until', 'reason', 'pool'],
  'quota status': [], 'quota clear': ['all'], 'quota check': ['refresh', 'on-error', 'claude-usage', 'json'],
};
const ARGUMENTS = { upgrade: [0, 0], 'availability mark': [2, 2], 'quota set': [1, 1], 'quota clear': [0, 1], 'quota check': [0, 1], ref: [1, 1], 'trace record': [0, 1] };

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const argument = { '-h': '--help', '-v': '--version' }[argv[i]] ?? argv[i];
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    const [, name, inline] = argument.match(/^--([^=]+)(?:=(.*))?$/s) ?? [];
    if (SWITCHES.includes(name) && inline === undefined) flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const value = inline ?? argv[(i += 1)];
      // --flags carries other flags as its text, so it may start with "--" or be empty.
      const missing = name === 'flags' ? value === undefined : !value || (inline === undefined && value.startsWith('--'));
      if (missing) throw new CliError(`--${name} needs a value`, 2);
      flags[name] = value;
    } else throw new CliError(`unknown option ${argument}`, 2);
  }
  return { flags, positional };
}

function parseProviders(value) {
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new CliError('--providers needs a value', 2);
  return names.map((name) => parseChoice(name, Object.keys(HEAVY_MODELS), 'provider'));
}

function rawConfig(target) {
  const file = path.join(target, CONFIG_FILE);
  try { return readJson(file); } catch (error) { throw new CliError(`${file}: cannot read valid config JSON (${error.code ?? error.name})`); }
}

async function sync(target, { yes = false, dryRun = false, force = false, providers, refresh = false, probeScarce = false, apply = false } = {}) {
  if (apply) {
    const config = rawConfig(target);
    const availability = readAvailabilityFile(target);
    if (!availability) throw new CliError('no availability cache; run t3-auto-build check-models first');
    const result = applyDrift(config, availability);
    for (const promotion of result.promoted) console.log(`promoted ${promotion.provider}:${promotion.from} -> ${promotion.provider}:${promotion.to}`);
    for (const unknown of result.unknown) console.log(`unknown family ${unknown.provider}:${unknown.model} (left disabled)`);
    if (!result.promoted.length) console.log('no known model drift to apply');
    else if (dryRun) console.log('nothing was written');
    else await syncConfig(target, result.config, { force, log: console.log });
    return;
  }
  if (!yes && !dryRun && !process.stdin.isTTY) throw new CliError('no interactive terminal; re-run with --auto (or --dry-run); nothing was written', 2);
  const manifest = readManifest(target);
  if (!dryRun && !(manifest && wantsAuto(manifest.modules))) throw new CliError(`no auto-build installation in ${target}; run init first`);
  let declined = false;
  const confirm = async ({ allowlist, planRestricted, cooldowns, changed }) => {
    if (force || changed || Object.keys(cooldowns).length) {
      console.log(JSON.stringify({ allowlist, planRestricted, cooldowns }, null, 2));
      if (await confirmYes(`Write these changes to ${target}? [y/N] `)) return true;
    }
    declined = true; return false;
  };
  const summary = await syncModels(target, { providers, dryRun, yes, force, refresh, probeScarce, confirm });
  if (dryRun) {
    const { allowlist, planRestricted, cooldowns, changed } = summary;
    console.log(JSON.stringify({ allowlist, planRestricted, cooldowns, changed }, null, 2));
  }
  console.log(dryRun || declined ? 'nothing was written' : 'done: models synced');
}

async function init(target, flags) {
  const options = {
    force: flags.force,
    preset: flags.preset === undefined ? undefined : parseChoice(flags.preset, PRESETS, 'preset'),
    modules: flags.modules === undefined ? undefined : parseChoice(flags.modules, MODULES, 'modules'),
    compaction: flags.compaction === undefined ? undefined : parsePercent(flags.compaction),
    tiers: flags.tiers === undefined ? undefined : parseTierSpec(flags.tiers),
    claudeTier: flags['claude-tier'], codexTier: flags['codex-tier'], antigravityTier: flags['antigravity-tier'],
    parent: flags.parent, allowUsageCredits: flags['allow-usage-credits'], allowFastModes: flags['allow-fast-modes'], verifiedOrg: flags['verified-org'],
    skillTargets: parseSkillTargets(flags['skill-targets']),
  };
  for (const provider of PROVIDERS) {
    const field = { claude: 'claudeTier', codex: 'codexTier', antigravity: 'antigravityTier' }[provider];
    if (options[field] !== undefined && !Object.hasOwn(CATALOG[provider], options[field])) {
      throw new CliError(`unknown ${provider} tier "${options[field]}"; valid tiers: ${Object.keys(CATALOG[provider]).join(', ')}`, 2);
    }
  }
  if (options.parent !== undefined && !['sonnet', 'opus', 'fable'].includes(options.parent)) {
    throw new CliError('--parent must be sonnet, opus or fable', 2);
  }
  let finalOptions = options;
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new CliError('no interactive terminal; re-run with --yes (and tier flags)', 2);
    finalOptions = await initPrompts(target, options);
  }
  install(target, finalOptions);
  if (!flags.probe) return;
  if (wantsAuto(readManifest(target).modules)) await sync(target, { yes: true });
  else console.log('warning: --probe does not apply to the core module; ignored');
}

async function check(target, flags) {
  const config = rawConfig(target);
  const result = await checkModels({
    configDir: target, config, refresh: flags.refresh, probeScarce: flags['probe-scarce'], recheckLocks: flags['recheck-locks'],
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`availability ${result.stale ? 'stale' : 'fresh'}; probed ${result.probed.length}; skipped scarce ${result.skippedScarce.length}`);
    for (const { ref, status } of result.statuses) console.log(`${ref} ${status}`);
    for (const { key, provider, model, result: outcome } of result.rechecked) {
      console.log(outcome === 'via-t3' ? `recheck-via-t3: ${provider} (${model})` : `rechecked ${key} with ${model}: ${outcome}`);
    }
    for (const entry of result.availability.discoveredNew ?? []) console.log(`discovered ${entry.provider}:${entry.model}${entry.supersedes ? ` supersedes ${entry.supersedes}` : ' (unknown family)'}`);
  }
}

function availability(action, target, args, flags) {
  if (action === 'status') {
    const { data, stale } = readAvailability(path.join(target, AVAILABILITY_FILE));
    if (!data) { console.log('availability cache missing or malformed'); return; }
    const age = Math.max(0, Date.now() - Date.parse(data.checkedAt));
    const ageText = Number.isFinite(age) ? ` (${(age / 3_600_000).toFixed(1)}h old)` : '';
    console.log(`availability cache ${stale ? 'stale' : 'fresh'}${ageText}`);
    for (const [ref, entry] of Object.entries(data.models ?? {})) console.log(`${ref}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`);
    console.log(`drift: ${(data.discoveredNew ?? []).length} discovered, ${(data.missingConfigured ?? []).length} missing configured`);
  } else markAvailability({ configDir: target, ref: args[0], status: args[1], ttl: flags.ttl, reason: flags.reason });
}

async function quotaReport(target, subject, flags) {
  const onError = flags['on-error'];
  if (onError && subject === undefined) throw new CliError('quota check --on-error needs a provider or provider:model', 2);
  const result = await quotaCheck(target, {
    subject, onError, refresh: flags.refresh, claudeUsage: flags['claude-usage'],
    // Progress lines would corrupt the JSON on stdout.
    log: flags.json ? () => {} : console.log,
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else if (onError) console.log(`action: ${result.action}`);
}

function quota(action, target, subject, flags) {
  if (action === 'status') return quotaStatus(target);
  if (action === 'check') return quotaReport(target, subject, flags);
  if (action === 'clear') {
    if ((subject === undefined) !== Boolean(flags.all)) throw new CliError('quota clear needs a provider, a model or --all (not both)', 2);
    return quotaClear(target, flags.all ? { all: true } : subject);
  }
  const chosen = [...QUOTA_WINDOWS, 'until'].filter((name) => flags[name] !== undefined);
  if (chosen.length > 1) throw new CliError(`use only one of ${chosen.map((name) => `--${name}`).join(', ')}`, 2);
  return quotaSet(target, subject, { window: chosen[0] === 'until' ? undefined : chosen[0], until: flags.until, reason: flags.reason, pool: flags.pool });
}

function projectDir(value) {
  if (value === undefined) return undefined;
  const dir = path.resolve(value);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new CliError(`--cwd is not a directory: ${dir}`, 2);
  return dir;
}

async function preflight(target, flags) {
  const result = await runPreflight({ configDir: target, cwd: projectDir(flags.cwd), flags: flags.flags, refresh: flags.refresh });
  console.log(flags.json ? JSON.stringify(result, null, 2) : formatPreflight(result));
}

const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : NaN);

function trace(target, json, flags) {
  const fields = TRACE_FLAGS.filter((name) => flags[name] !== undefined);
  if ((json === undefined) === (fields.length === 0)) throw new CliError('trace record needs a JSON entry or field flags (not both)', 2);
  let entry;
  if (json === undefined) {
    entry = Object.fromEntries(fields.map((name) => (name === 'duration'
      ? ['durationMs', wholeNumber(flags.duration)] : [name, flags[name]])));
  } else {
    try { entry = parseJson(json); } catch { throw new CliError('trace record: the entry is not valid JSON', 2); }
  }
  const { telemetry } = loadConfig(target);
  if (telemetry?.enabled === false) return console.log('telemetry is disabled; nothing was recorded');
  recordTrace(target, entry, { maxBytes: telemetry?.maxBytes });
  console.log('recorded');
}

function stats(target, flags) {
  const days = flags.days === undefined ? undefined : wholeNumber(flags.days);
  if (days !== undefined && !(days > 0)) throw new CliError('--days must be a whole number above 0', 2);
  const summary = summarizeStats(target, { days });
  console.log(flags.json ? JSON.stringify(summary, null, 2) : formatStats(summary));
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) return console.log(USAGE);
  if (flags.version) return console.log(PACKAGE_VERSION);
  const [first, ...rest] = positional;
  const command = ['quota', 'availability', 'trace'].includes(first) ? `${first} ${rest.shift()}` : first;
  const [min, max] = ARGUMENTS[command] ?? [0, 0];
  if (!Object.hasOwn(COMMAND_FLAGS, command) || rest.length < min || rest.length > max) throw new CliError(USAGE, 2);
  const stray = Object.keys(flags).find((name) => name !== 'target' && !COMMAND_FLAGS[command].includes(name));
  if (stray) throw new CliError(`--${stray} is not valid with ${command}`, 2);
  if (command === 'doctor' && flags.yes && !flags.fix) throw new CliError('--yes is only valid with doctor --fix', 2);
  const target = resolveTarget(flags.target);
  if (command === 'init') await init(target, flags);
  else if (command === 'upgrade') await upgrade(target);
  else if (command === 'doctor') process.exitCode = await doctor(target, { fix: flags.fix, yes: flags.yes, cwd: projectDir(flags.cwd) });
  else if (command === 'preflight') await preflight(target, flags);
  else if (command === 'ref') console.log(getReference(rest[0], { configDir: target }));
  else if (command === 'trace record') trace(target, rest[0], flags);
  else if (command === 'stats') stats(target, flags);
  else if (command === 'uninstall') uninstall(target);
  else if (command === 'check-models') await check(target, flags);
  else if (command === 'availability mark' || command === 'availability status') availability(command.slice('availability '.length), target, rest, flags);
  else if (command === 'sync-models') {
    const providers = flags.providers === undefined ? undefined : parseProviders(flags.providers);
    await sync(target, { yes: flags.yes || flags.auto, dryRun: flags['dry-run'], force: flags.force, providers, refresh: flags.refresh, probeScarce: flags['probe-scarce'], apply: flags.apply });
  } else await quota(command.slice('quota '.length), target, rest[0], flags);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : `unexpected error: ${error.stack}`}\n`);
  process.exitCode = error.exitCode ?? 1;
});

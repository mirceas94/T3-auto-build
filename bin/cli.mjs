#!/usr/bin/env node
import { HEAVY_MODELS } from '../lib/detect.mjs';
import { doctor } from '../lib/doctor.mjs';
import { PRESETS, install, uninstall, wantsAuto } from '../lib/install.mjs';
import { MODULES, readManifest } from '../lib/manifest.mjs';
import { CliError, resolveTarget } from '../lib/paths.mjs';
import { syncModels } from '../lib/probe.mjs';
import { confirmYes, initPrompts, parseChoice, parsePercent, parseTierSpec } from '../lib/prompt.mjs';
import { QUOTA_WINDOWS, quotaCheck, quotaClear, quotaSet, quotaStatus } from '../lib/quota.mjs';

const USAGE = `Usage: t3-auto-build <command> [options]

Commands:
  init                    install or update (interactive unless --yes)
  doctor                  check an installation
  uninstall               remove what init installed, keeping your edits
  sync-models             probe the models and update the allowlist
  quota set <subject>     lock a provider (claude, codex, antigravity) or a model
  quota status            show active locks and drop expired ones
  quota clear [subject]   remove the locks of a provider or model (or --all)
  quota check [provider]  run the official login status commands

Options:
  --target <dir>      config dir (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  -h, --help          show this help
  init only:
  --preset <name>     ${PRESETS.join(' | ')}
  --modules <name>    ${MODULES.join(' | ')}
  --compaction <n>    auto-compaction threshold, 1-100
  --tiers <list>      provider:plan[:weekday], comma separated, e.g. claude:max,codex:pro
  --probe             run sync-models after installing (spends real quota)
  --yes               do not prompt
  sync-models only:
  --dry-run           show the result without writing. Note: sync-models --dry-run
                      still executes live probes (spends real quota) but writes nothing.
  --providers <list>  only these providers, comma separated
  --yes               write without asking
  init and sync-models:
  --force             back up your edited files to .bak, then overwrite. sync-models applies it
                      to a hand-edited SKILL.md (default: skip it with a warning)
  quota set only (one window, default --burst):
  --burst             10 minutes
  --5h                5 hours
  --weekly            until the tier's weekly reset day, else 7 days
  --until <when>      ISO time, or a duration such as 90m or 1w2d
  --reason <text>     note shown by quota status
  quota clear only:
  --all               remove every lock`;

const VALUE_FLAGS = ['target', 'preset', 'modules', 'compaction', 'tiers', 'providers', 'until', 'reason'];
const SWITCHES = ['yes', 'force', 'help', 'probe', 'dry-run', 'all', ...QUOTA_WINDOWS];
const COMMAND_FLAGS = {
  init: ['preset', 'modules', 'compaction', 'tiers', 'probe', 'yes', 'force'],
  doctor: [],
  uninstall: [],
  'sync-models': ['dry-run', 'providers', 'yes', 'force'],
  'quota set': [...QUOTA_WINDOWS, 'until', 'reason'],
  'quota status': [],
  'quota clear': ['all'],
  'quota check': [],
};
// [min, max] positional arguments after the command.
const ARGUMENTS = { 'quota set': [1, 1], 'quota clear': [0, 1], 'quota check': [0, 1] };

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] === '-h' ? '--help' : argv[i];
    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    const [, name, inline] = argument.match(/^--([^=]+)(?:=(.*))?$/s) ?? [];
    if (SWITCHES.includes(name) && inline === undefined) {
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const value = inline ?? argv[(i += 1)];
      if (!value || (inline === undefined && value.startsWith('--'))) throw new CliError(`--${name} needs a value`, 2);
      flags[name] = value;
    } else {
      throw new CliError(`unknown option ${argument}`, 2);
    }
  }
  return { flags, positional };
}

function parseProviders(value) {
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new CliError('--providers needs a value', 2);
  return names.map((name) => parseChoice(name, Object.keys(HEAVY_MODELS), 'provider'));
}

async function sync(target, { yes = false, dryRun = false, force = false, providers }) {
  if (!yes && !dryRun && !process.stdin.isTTY) {
    throw new CliError('no interactive terminal; re-run with --yes (or --dry-run); nothing was written', 2);
  }
  // Checked before probing, so quota is not spent on results that cannot be saved.
  const manifest = readManifest(target);
  if (!dryRun && !(manifest && wantsAuto(manifest.modules))) {
    throw new CliError(`no auto-build installation in ${target}; run init first`);
  }
  let declined = false;
  const confirm = async ({ allowlist, planRestricted, cooldowns, changed }) => {
    if (force || changed || Object.keys(cooldowns).length) {
      console.log(JSON.stringify({ allowlist, planRestricted, cooldowns }, null, 2));
      if (await confirmYes(`Write these changes to ${target}? [y/N] `)) return true;
    }
    declined = true;
    return false;
  };
  const summary = await syncModels(target, { providers, dryRun, yes, force, confirm });
  if (dryRun) {
    const { allowlist, planRestricted, cooldowns, changed } = summary;
    console.log(JSON.stringify({ allowlist, planRestricted, cooldowns, changed }, null, 2));
  }
  console.log(dryRun || declined ? 'nothing was written' : 'done: models synced');
}

async function init(target, flags) {
  let options = {
    force: flags.force,
    preset: flags.preset === undefined ? undefined : parseChoice(flags.preset, PRESETS, 'preset'),
    modules: flags.modules === undefined ? undefined : parseChoice(flags.modules, MODULES, 'modules'),
    compaction: flags.compaction === undefined ? undefined : parsePercent(flags.compaction),
    tiers: flags.tiers === undefined ? undefined : parseTierSpec(flags.tiers),
  };
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new CliError('no interactive terminal; re-run with --yes (and --preset/--modules/--compaction)', 2);
    options = await initPrompts(target, options);
  }
  install(target, options);
  if (!flags.probe) return;
  if (wantsAuto(readManifest(target).modules)) await sync(target, { yes: flags.yes });
  else console.log('warning: --probe does not apply to the core module; ignored');
}

function quota(action, target, subject, flags) {
  if (action === 'status') return quotaStatus(target);
  if (action === 'check') return quotaCheck(target, { providers: subject === undefined ? undefined : [subject] });
  if (action === 'clear') {
    if ((subject === undefined) !== Boolean(flags.all)) throw new CliError('quota clear needs a provider, a model or --all (not both)', 2);
    return quotaClear(target, flags.all ? { all: true } : subject);
  }
  const chosen = [...QUOTA_WINDOWS, 'until'].filter((name) => flags[name] !== undefined);
  if (chosen.length > 1) throw new CliError(`use only one of ${chosen.map((name) => `--${name}`).join(', ')}`, 2);
  return quotaSet(target, subject, {
    window: chosen[0] === 'until' ? undefined : chosen[0], until: flags.until, reason: flags.reason,
  });
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) return console.log(USAGE);
  const [first, ...rest] = positional;
  const command = first === 'quota' ? `quota ${rest.shift()}` : first;
  const [min, max] = ARGUMENTS[command] ?? [0, 0];
  if (!Object.hasOwn(COMMAND_FLAGS, command) || rest.length < min || rest.length > max) throw new CliError(USAGE, 2);
  const stray = Object.keys(flags).find((name) => name !== 'target' && !COMMAND_FLAGS[command].includes(name));
  if (stray) throw new CliError(`--${stray} is not valid with ${command}`, 2);
  const target = resolveTarget(flags.target);

  if (command === 'init') await init(target, flags);
  else if (command === 'doctor') process.exitCode = doctor(target);
  else if (command === 'uninstall') uninstall(target);
  else if (command === 'sync-models') {
    const providers = flags.providers === undefined ? undefined : parseProviders(flags.providers);
    await sync(target, { yes: flags.yes, dryRun: flags['dry-run'], force: flags.force, providers });
  } else await quota(command.slice('quota '.length), target, rest[0], flags);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : `unexpected error: ${error.stack}`}\n`);
  process.exitCode = error.exitCode ?? 1;
});

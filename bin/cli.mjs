#!/usr/bin/env node
import path from 'node:path';
import { CONFIG_FILE, readJson } from '../hooks/_shared.mjs';
import { doctor } from '../lib/doctor.mjs';
import { PRESETS, completeConfig, install, uninstall } from '../lib/install.mjs';
import { MODULES, readManifest } from '../lib/manifest.mjs';
import { CliError, resolveTarget } from '../lib/paths.mjs';
import { parseChoice, parsePercent, promptOptions } from '../lib/prompt.mjs';

const USAGE = `Usage: t3-auto-build <command> [options]

Commands:
  init        install or update (interactive unless --yes)
  doctor      check an installation
  uninstall   remove what init installed, keeping your edits

Options:
  --target <dir>      config dir (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  init only:
  --preset <name>     ${PRESETS.join(' | ')}
  --modules <name>    ${MODULES.join(' | ')}
  --compaction <n>    auto-compaction threshold, 1-100
  --yes               do not prompt
  --force             back up your edited files to .bak, then overwrite
  -h, --help          show this help`;

const VALUE_FLAGS = ['target', 'preset', 'modules', 'compaction'];
const SWITCHES = ['yes', 'force', 'help'];

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

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) return console.log(USAGE);
  const [command, ...extra] = positional;
  if (!['init', 'doctor', 'uninstall'].includes(command) || extra.length) throw new CliError(USAGE, 2);
  const target = resolveTarget(flags.target);

  if (command !== 'init') {
    const initOnly = Object.keys(flags).find((name) => name !== 'target');
    if (initOnly) throw new CliError(`--${initOnly} is only valid with init`, 2);
    if (command === 'doctor') process.exitCode = doctor(target);
    else uninstall(target);
    return;
  }

  let options = {
    force: flags.force,
    preset: flags.preset === undefined ? undefined : parseChoice(flags.preset, PRESETS, 'preset'),
    modules: flags.modules === undefined ? undefined : parseChoice(flags.modules, MODULES, 'modules'),
    compaction: flags.compaction === undefined ? undefined : parsePercent(flags.compaction),
  };
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new CliError('no interactive terminal; re-run with --yes (and --preset/--modules/--compaction)', 2);
    let config = {};
    try {
      config = readJson(path.join(target, CONFIG_FILE));
    } catch {
      // no usable config yet; install() reports a broken one
    }
    const { preset, compactionThreshold } = completeConfig(config ?? {});
    const current = { modules: readManifest(target)?.modules ?? 'full', preset, compaction: compactionThreshold };
    options = await promptOptions(options, current);
  }
  install(target, options);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : `unexpected error: ${error.stack}`}\n`);
  process.exitCode = error.exitCode ?? 1;
});

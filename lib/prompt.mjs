import path from 'node:path';
import readline from 'node:readline/promises';
import { CONFIG_FILE, isObject, readJson } from '../hooks/_shared.mjs';
import { detect as detectProviders, parseTiers } from './detect.mjs';
import { MODULES, readManifest } from './manifest.mjs';
import { PRESETS, completeConfig } from './install.mjs';
import { CliError } from './paths.mjs';

const MODULE_LABELS = { full: 'Full Suite', 'auto-build': '/auto-build Only', core: 'Core Discipline + Commands' };
const PLAN_NAMES = { claude: 'pro|max', codex: 'plus|pro', antigravity: 'standard|ultra' };

/** parseTiers, with a bad value reported as a usage error. */
export function parseTierSpec(spec) {
  try {
    return parseTiers(spec);
  } catch (error) {
    if (error instanceof CliError) error.exitCode = 2;
    throw error;
  }
}

/** Yes only on an explicit "y" or "yes"; closed input counts as no. */
export async function confirmYes(question, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const lines = rl[Symbol.asyncIterator]();
    output.write(question);
    const { value, done } = await lines.next();
    return !done && /^y(es)?$/i.test(value.trim());
  } finally {
    rl.close();
  }
}

/** The init questions, defaulting to the installed config, or on a fresh one to the detected CLIs. */
export async function initPrompts(target, options, { detect = detectProviders, input, output } = {}) {
  let config = null;
  try {
    config = readJson(path.join(target, CONFIG_FILE));
  } catch {
    // no usable config yet; install() reports a broken one
  }
  const found = detect();
  const complete = completeConfig(config ?? {});
  const current = {
    modules: readManifest(target)?.modules ?? 'full',
    preset: config ? complete.preset : found.preset,
    compaction: complete.compactionThreshold,
    providers: Object.keys(found.providers).filter((name) => found.providers[name].binary),
    tiers: isObject(complete.tiers) ? complete.tiers : {},
  };
  const answers = await promptOptions(options, current, input, output);
  if (!config && (answers.modules ?? current.modules) !== 'core') answers.preset ??= found.preset;
  return answers;
}

export function parseChoice(value, choices, name) {
  const text = value.trim().toLowerCase();
  const choice = choices.includes(text) ? text : /^\d+$/.test(text) ? choices[Number(text) - 1] : undefined;
  if (!choice) throw new CliError(`invalid ${name} "${value}" (expected ${choices.join(', ')})`, 2);
  return choice;
}

export function parsePercent(value) {
  const text = value.trim();
  const percent = Number(text);
  if (!/^\d+$/.test(text) || percent < 1 || percent > 100) {
    throw new CliError(`invalid compaction "${value}" (expected an integer from 1 to 100)`, 2);
  }
  return percent;
}

/** Ask for whatever the flags left open. Enter keeps the current value (answer stays undefined). */
export async function promptOptions(options, current, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    output.write(question);
    const { value, done } = await lines.next();
    if (done) throw new CliError('input closed; nothing was changed', 2);
    return value.trim();
  };
  const numbered = (items) => items.map((item, i) => `  ${i + 1}) ${item}`).join('\n');
  const answers = { ...options };
  try {
    if (answers.modules === undefined) {
      const reply = await ask(`Modules:\n${numbered(MODULES.map((m) => `${m} - ${MODULE_LABELS[m]}`))}\nChoose [${current.modules}]: `);
      if (reply) answers.modules = parseChoice(reply, MODULES, 'modules');
    }
    if ((answers.modules ?? current.modules) === 'core') return answers;
    if (answers.preset === undefined) {
      const reply = await ask(`Preset:\n${numbered(PRESETS)}\nChoose [${current.preset}]: `);
      if (reply) answers.preset = parseChoice(reply, PRESETS, 'preset');
    }
    const banned = await ask('Extra banned models, comma separated [none]: ');
    answers.banned = banned.split(',').map((name) => name.trim()).filter(Boolean);
    if (answers.compaction === undefined) {
      const reply = await ask(`Auto-compaction threshold, percent 1-100 [${current.compaction}]: `);
      if (reply) answers.compaction = parsePercent(reply);
    }
    if (options.tiers === undefined) {
      for (const provider of current.providers ?? []) {
        const kept = current.tiers?.[provider]?.plan ?? 'skip';
        const plan = await ask(`${provider} subscription tier (${PLAN_NAMES[provider]}) [${kept}]: `);
        if (!plan) continue;
        const day = await ask(`${provider} weekly reset day, such as monday [skip]: `);
        answers.tiers = { ...answers.tiers, ...parseTierSpec([provider, plan, day].filter(Boolean).join(':')) };
      }
    }
    return answers;
  } finally {
    rl.close();
  }
}

import readline from 'node:readline/promises';
import { MODULES } from './manifest.mjs';
import { PRESETS } from './install.mjs';
import { CliError } from './paths.mjs';

const MODULE_LABELS = { full: 'Full Suite', 'auto-build': '/auto-build Only', core: 'Core Discipline + Commands' };

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
    return answers;
  } finally {
    rl.close();
  }
}

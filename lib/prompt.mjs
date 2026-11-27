import path from 'node:path';
import readline from 'node:readline/promises';
import { CONFIG_FILE, isObject, isSupportedSchema, readJson } from '../hooks/_shared.mjs';
import { detect as detectProviders, parseTiers } from './detect.mjs';
import { MODULES, readManifest } from './manifest.mjs';
import { ASSUMED_TIERS, PRESETS, completeConfig } from './install.mjs';
import { CliError } from './paths.mjs';
import { CATALOG, PROVIDERS } from './plans.mjs';

const MODULE_LABELS = { full: 'Full Suite', 'auto-build': '/auto-build Only', core: 'Core Discipline + Commands' };
const PLAN_NAMES = { claude: 'pro|max', codex: 'plus|pro', antigravity: 'standard|ultra' };
export const TIER_FLAGS = { claude: '--claude-tier', codex: '--codex-tier', antigravity: '--antigravity-tier' };

/** A saved config carries no warnings, so they come from the catalog. */
const catalogWarnings = (config) => PROVIDERS.flatMap((provider) => {
  const id = config.subscriptions?.[provider] ?? 'none';
  const tier = CATALOG[provider][id];
  if (!tier?.warning || id === 'none') return [];
  const excluded = tier.usageBilled && !config.allowUsageCredits
    ? [`${provider} ${id}: models excluded; pass --allow-usage-credits to use them`] : [];
  return [`${provider} ${id}: ${tier.warning}`, ...excluded];
});

/** Plain text overview of a resolveTiers() result or a v2 config, shown before it is written. */
export function summaryTable(resolved) {
  const names = (models) => models.map((m) => m.model).join(', ') || '-';
  const rows = [['provider', 'tier', 'CLI', 'models (standard)', 'scarce overflow', 'max parallel']];
  for (const provider of PROVIDERS) {
    const id = resolved.subscriptions?.[provider] ?? 'none';
    const tier = CATALOG[provider][id];
    const models = (resolved.models ?? []).filter((m) => m.provider === provider);
    rows.push([provider, id, tier?.cliSupported ? 'yes' : 'no', names(models.filter((m) => !m.scarceQuota)),
      names(models.filter((m) => m.scarceQuota)), String(models.length ? tier?.maxParallelBuilders ?? 0 : 0)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  const lines = rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd());
  lines.push(`parent: ${resolved.parent ? `${resolved.parent.model} (${resolved.parent.effort})` : 'none'}`);
  lines.push(`max parallel builders: ${resolved.maxParallelBuilders ?? 0}`);
  const warnings = (resolved.warnings ?? catalogWarnings(resolved)).filter((text) => !/^\w+ none:/.test(text));
  lines.push(...warnings.map((text) => `warning: ${text}`));
  return lines.join('\n');
}

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
  const v2 = isSupportedSchema(config);
  // Default tier per provider. null (v1 config) keeps that config unless a tier is typed.
  current.subscriptions = Object.fromEntries(PROVIDERS.map((provider) => {
    if (v2) return [provider, config.subscriptions?.[provider] ?? 'none'];
    if (config) return [provider, null];
    return [provider, found.providers[provider]?.binary ? ASSUMED_TIERS[provider] : 'none'];
  }));
  current.v2 = v2;
  current.parent = config?.parent?.model;
  current.allowUsageCredits = config?.allowUsageCredits;
  const answers = await promptOptions(options, current, input, output);
  if (!config && (answers.modules ?? current.modules) !== 'core' && !tiered(answers, v2)) answers.preset ??= found.preset;
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

/** True when subscription tiers, not a preset, decide the providers. */
const tiered = (answers, v2) => v2 || PROVIDERS.some((provider) => {
  const tier = answers[`${provider}Tier`] ?? answers.subscriptions?.[provider];
  return tier !== undefined && tier !== 'none';
});

/** One tier question per provider without a flag, then the parent when the Claude tier offers a choice. */
async function askTiers(options, current, answers, ask, output) {
  const subscriptions = {};
  for (const provider of PROVIDERS) {
    let tier = options[`${provider}Tier`];
    if (tier === undefined) {
      const ids = Object.keys(CATALOG[provider]);
      const kept = current.subscriptions[provider];
      const reply = await ask(`${provider} subscription tier (${ids.join(', ')}) [${kept ?? 'keep'}]: `);
      tier = reply ? parseChoice(reply, ids, `${provider} tier`) : kept;
    }
    if (tier !== null) subscriptions[provider] = tier;
    const chosen = CATALOG[provider][tier];
    if (tier !== 'none' && chosen?.warning) output.write(`warning: ${provider} ${tier}: ${chosen.warning}\n`);
  }
  answers.subscriptions = subscriptions;

  const claude = CATALOG.claude[options.claudeTier ?? subscriptions.claude];
  const usable = claude && (!claude.usageBilled || (options.allowUsageCredits ?? current.allowUsageCredits));
  if (options.parent === undefined && usable && claude.parentOptions.length > 1) {
    const kept = claude.parentOptions.includes(current.parent) ? current.parent : claude.parentDefault.model;
    const reply = await ask(`Parent model (${claude.parentOptions.join(', ')}) [${kept}]: `);
    if (reply) answers.parent = parseChoice(reply, claude.parentOptions, 'parent');
  }
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
    const subscriptionMode = current.subscriptions !== undefined && options.tiers === undefined;
    if (subscriptionMode) await askTiers(options, current, answers, ask, output);
    // Subscription tiers decide the providers, so a preset is only asked without them.
    if (answers.preset === undefined && !(subscriptionMode && tiered(answers, current.v2))) {
      const reply = await ask(`Preset:\n${numbered(PRESETS)}\nChoose [${current.preset}]: `);
      if (reply) answers.preset = parseChoice(reply, PRESETS, 'preset');
    }
    const banned = await ask('Extra banned models, comma separated [none]: ');
    answers.banned = banned.split(',').map((name) => name.trim()).filter(Boolean);
    if (answers.compaction === undefined) {
      const reply = await ask(`Auto-compaction threshold, percent 1-100 [${current.compaction}]: `);
      if (reply) answers.compaction = parsePercent(reply);
    }
    if (options.tiers === undefined && !subscriptionMode) {
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

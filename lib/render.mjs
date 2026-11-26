import { CONFIG_FILE, COOLDOWN_FILE, displayPath, effectiveAllowlist } from '../hooks/_shared.mjs';
import { CliError } from './paths.mjs';

export const LADDERS = ['tier1', 'commandRunner', 'builderA', 'testerA', 'auditorA', 'builderB', 'testerB', 'auditorB', 'architect', 'dualAudit'];

/** Fill {{slot}} placeholders; an unknown slot is an error. */
export function fillTemplate(template, values) {
  return template.replace(/\{\{([^{}]*)\}\}/g, (match, name) => {
    const key = name.trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new CliError(`unresolved template slot ${match}`);
    return String(values[key]);
  });
}

const code = (text) => `\`${text}\``;

/** Render SKILL.md from the config. Banned or non-allowlisted ladder entries are dropped. */
export function renderSkill(template, config, configDir) {
  const groups = effectiveAllowlist(config);
  const allowed = new Map(groups.flatMap(([, models]) => models).map((model) => [model.toLowerCase(), model]));
  if (allowed.size === 0) throw new CliError('the allowlist is empty after removing banned models');

  const ladders = Object.fromEntries(
    LADDERS.map((name) => {
      const entries = (config.ladders[name] ?? []).flatMap((entry) => {
        const [model, effort] = entry.split('@');
        const known = allowed.get(model.trim().toLowerCase());
        return known ? [{ model: known, effort }] : [];
      });
      if (entries.length === 0) {
        throw new CliError(`ladder "${name}" has no model left after removing banned and non-allowlisted entries; edit ${CONFIG_FILE}`);
      }
      return [name, entries];
    }),
  );
  const describe = ({ model, effort }) => `${code(model)}${effort ? ` (${code(effort)})` : ''}`;
  const duals = ladders.dualAudit.map(describe);
  const defaultModel = allowed.get(config.defaultModel.toLowerCase()) ?? ladders.builderA[0].model;
  const flags = groups.map(([provider, models]) => ({ flag: `--${provider.toLowerCase().replace(/\s+/g, '-')}-only`, provider, models }));

  return fillTemplate(template, {
    ...Object.fromEntries(LADDERS.map((name) => [name, ladders[name].map(describe).join(' -> ')])),
    modelCount: allowed.size,
    allowlist: groups.map(([provider, models]) => `- **${provider}:** ${models.map(code).join(', ')}`).join('\n'),
    providerFlags: flags
      .map(({ flag, provider, models }) => `- \`${flag}\`: Restrict all steps and failovers to allowlisted ${provider} models (${models.map(code).join(', ')}).`)
      .join('\n'),
    banned: config.bannedModels.length ? `${config.bannedModels.join(', ')}, or ` : '',
    defaultModel,
    defaultEffort: config.defaultEffort,
    compactionThreshold: config.compactionThreshold,
    firstBuilderA: ladders.builderA[0].model,
    firstBuilderB: ladders.builderB[0].model,
    dualAuditNames: ladders.dualAudit.map(({ model }) => code(model)).join(' and '),
    dualAuditRun: duals.length > 1 ? `Run ${duals.join(' AND ')} in parallel` : `Run ${duals[0]}`,
    cooldownsPath: displayPath(configDir, COOLDOWN_FILE),
    configPath: displayPath(configDir, CONFIG_FILE),
  });
}

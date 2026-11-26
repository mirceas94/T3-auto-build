// Which provider CLIs are installed, and how their subscription tiers share limits. Node >=18, node:* only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which as findOnPath } from '../hooks/_shared.mjs';
import { CliError } from './paths.mjs';
import { MODELS } from './plans.mjs';

// Config directories under the home folder. Only their existence is checked; nothing inside is opened.
const MARKERS = { claude: ['.claude'], codex: ['.codex'], antigravity: ['.antigravity', '.gemini/antigravity'] };

/** A provider counts as installed only when its binary is on PATH; the marker is informational. */
export function detect({ which = findOnPath, exists = fs.existsSync, home = os.homedir() } = {}) {
  const providers = Object.fromEntries(Object.entries(MARKERS).map(([name, dirs]) => [name, {
    binary: which(name) ?? null,
    marker: dirs.some((dir) => Boolean(exists(path.join(home, dir)))),
  }]));
  const { claude, codex, antigravity } = providers;
  let preset = 'claude-only';
  if (claude.binary && codex.binary) preset = antigravity.binary ? 'tri-provider' : 'claude-codex';
  return { providers, preset };
}

// sharing: what a short-window limit locks, as _quota.parseRateLimit understands it.
const PLANS = {
  claude: { pro: 'provider', max: 'heavy-tier-only' },
  codex: { plus: 'provider', pro: 'heavy-tier-only' },
  antigravity: { standard: 'provider', ultra: 'heavy-tier-only' },
};
export const HEAVY_MODELS = Object.fromEntries(['claude', 'codex', 'antigravity'].map((provider) => [
  provider,
  Object.entries(MODELS).filter(([, model]) => model.provider === provider && model.scarceQuota).map(([id]) => id),
]));
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "claude:max,codex:pro:monday" to { claude: { plan, sharing, resetDay?, heavyModels }, ... }. */
export function parseTiers(spec) {
  const tiers = {};
  for (const item of String(spec ?? '').split(',')) {
    const [provider, plan, day, ...extra] = item.split(':').map((part) => part.trim().toLowerCase());
    if (!Object.hasOwn(PLANS, provider) || !Object.hasOwn(PLANS[provider], plan ?? '') || extra.length) {
      const valid = Object.entries(PLANS).map(([name, plans]) => `${name}:${Object.keys(plans).join('|')}`).join(', ');
      throw new CliError(`invalid tier "${item.trim()}"; expected provider:plan[:weekday] with ${valid}`);
    }
    if (Object.hasOwn(tiers, provider)) throw new CliError(`tier for "${provider}" is given twice`);
    const resetDay = day === undefined ? undefined : WEEKDAYS.find((name) => day === name || day === name.slice(0, 3));
    if (day !== undefined && !resetDay) throw new CliError(`invalid reset day "${day}"; use a weekday such as monday`);
    tiers[provider] = {
      plan,
      sharing: PLANS[provider][plan],
      ...(resetDay && { resetDay }),
      heavyModels: [...HEAVY_MODELS[provider]],
    };
  }
  return tiers;
}

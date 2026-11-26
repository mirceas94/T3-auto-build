// SessionStart: report subscriptions, active lockouts and the availability cache (6 lines at most); prune cooldowns.
import path from 'node:path';
import { prune, readCooldowns, summarize, writeCooldowns } from './_quota.mjs';
import {
  AVAILABILITY_FILE, COOLDOWN_FILE, PROVIDER_ALIASES, configDirOf, loadConfig, readAvailability, warn,
} from './_shared.mjs';

const HOUR = 60 * 60_000;
const lines = [];

// Each section fails alone, so one bad file never hides the others.
function section(name, report) {
  try {
    report();
  } catch (error) {
    warn(`ignoring ${name} (${error.name})`);
  }
}

const configDir = configDirOf(import.meta.url);

section('subscriptions', () => {
  const config = loadConfig(configDir);
  if (config.schemaVersion !== 2) {
    lines.push('AUTO-BUILD: legacy v1 config: run t3-auto-build upgrade');
    return;
  }
  // Config text goes into the session context: only known providers with a plain tier id are echoed.
  const tiers = [...new Set(PROVIDER_ALIASES.values())].flatMap((provider) => {
    const tier = config.subscriptions?.[provider];
    return typeof tier === 'string' && /^[a-z0-9-]{1,20}$/.test(tier) ? [`${provider}: ${tier}`] : [];
  });
  lines.push(`AUTO-BUILD subscriptions: ${tiers.join(', ') || 'unknown'}`);
});

section(COOLDOWN_FILE, () => {
  const file = path.join(configDir, COOLDOWN_FILE);
  // A malformed file throws here, so it is never overwritten.
  const { kept, removed } = prune(readCooldowns(file));
  lines.push(...summarize(kept));
  if (Object.keys(removed).length) writeCooldowns(file, kept);
});

section(AVAILABILITY_FILE, () => {
  const { data, stale } = readAvailability(path.join(configDir, AVAILABILITY_FILE));
  if (!data) {
    lines.push('AUTO-BUILD availability cache: missing — run t3-auto-build check-models');
    return;
  }
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(data.checkedAt)) / HOUR));
  lines.push(`AUTO-BUILD availability cache: ${stale ? 'stale' : `fresh (${age}h old)`}`);
  // Counts only: discovered ids are never echoed, and never allowed automatically.
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  const added = count(data.discoveredNew);
  const missing = count(data.missingConfigured);
  if (added || missing) {
    lines.push(`AUTO-BUILD model drift: ${added} new, ${missing} missing (not auto-allowed; run t3-auto-build check-models)`);
  }
});

if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);

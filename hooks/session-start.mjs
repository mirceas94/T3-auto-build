// SessionStart: report the active lockouts and prune expired cooldowns.
import path from 'node:path';
import { prune, readCooldowns, summarize, writeCooldowns } from './_quota.mjs';
import { COOLDOWN_FILE, configDirOf, warn } from './_shared.mjs';

try {
  const file = path.join(configDirOf(import.meta.url), COOLDOWN_FILE);
  // A malformed file throws here, so it is never overwritten.
  const { kept, removed } = prune(readCooldowns(file));
  const lines = summarize(kept);
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  if (Object.keys(removed).length) writeCooldowns(file, kept);
} catch (error) {
  warn(`ignoring ${COOLDOWN_FILE} (${error.name})`);
}

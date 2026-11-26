// PreCompact: print preservation rules plus a live git snapshot.
import fs from 'node:fs';
import { COOLDOWN_FILE, configDirOf, displayPath, effectiveAllowlist, loadConfig, prop, readPayload, run, warn, which } from './_shared.mjs';

const joinNames = (names) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function rules(configDir) {
  const config = loadConfig(configDir);
  const groups = effectiveAllowlist(config);
  const count = groups.reduce((total, [, models]) => total + models.length, 0);
  const allowed = groups.map(([provider, models]) => `${models.join(', ')} (${provider})`).join('; ');
  const banned = config.bannedModels;
  const bannedText = banned.length ? ` ${joinNames(banned)} ${banned.length > 1 || banned[0].includes('/') ? 'are' : 'is'} strictly banned.` : '';
  return `MANDATORY COMPACTION PRESERVATION RULES:
When summarizing this session, you MUST preserve verbatim:
1. STRICT ${count}-MODEL ALLOWLIST: Only ${allowed}.${bannedText}
2. ORCHESTRATOR STATE (if $auto-build is active): Active inline flags (--fast/--strict/--plan-only/--budget/etc.), complexity tier (L0-L3), full REPO_BRIEF, IMPLEMENTER_PROVIDER, in-run EXHAUSTED models, current pipeline step, files modified so far, and exact failing test/audit file:line items.
3. COOLDOWN STATE: Any active rate-limit/quota cooldowns recorded in ${displayPath(configDir, COOLDOWN_FILE)}.
4. ACTIVE SESSION STATE (all threads): Preserve a compact digest of:
   - Key architectural/constraint decisions already agreed upon.
   - Files already inspected or modified (so you do NOT re-read unchanged files after compaction).
   - Latest verification status (exact passing/failing test, lint, or typecheck commands and file:line errors).
   - Exact next action to resume cleanly without re-running discovery.
`;
}

function snapshot(cwd) {
  const git = which('git');
  if (!git) return '';
  const output = (...args) =>
    run(git, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
      ?.stdout ?? '';
  if (output('rev-parse', '--is-inside-work-tree').trim() !== 'true') return '';
  const branch = output('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const status = output('status', '--short').split(/\r?\n/).filter(Boolean);
  const lines = ['', `LIVE WORKTREE SNAPSHOT (branch: ${branch}):`];
  if (status.length === 0) lines.push('(clean working tree)');
  else lines.push(...status.slice(0, 20));
  if (status.length > 20) lines.push(`... (+${status.length - 20} more files)`);
  return `${lines.join('\n')}\n`;
}

try {
  const requested = prop(await readPayload(), 'cwd');
  const cwd = typeof requested === 'string' && requested && fs.existsSync(requested) ? requested : process.cwd();
  process.stdout.write(rules(configDirOf(import.meta.url)) + snapshot(cwd));
} catch (error) {
  warn(`pre-compact failed (${error.message})`);
}

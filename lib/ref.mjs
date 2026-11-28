// On-demand reference text behind `t3-auto-build ref <topic>`, so the skill does not have to carry it.
import {
  CONFIG_FILE, COOLDOWN_FILE, LEDGER_FILE, displayPath, effectiveAllowlist, loadConfig,
} from '../hooks/_shared.mjs';
import { CliError, resolveTarget } from './paths.mjs';

export const REF_TOPICS = ['flags', 'cooldowns', 'state', 'rules', 'all'];

const RULES = `## Orchestration rules
- Isolation: Triage records the repo's test isolation rules (temporary HOME, USERPROFILE and app data dirs, no real provider CLIs, ...) in .claude/repo-profile.md. Every Handoff Packet (builder, tester, auditor, architect) includes them.
- Contract freeze: shared behavioral contracts (signatures plus semantics) land in wave 1. A later parallel builder that needs a change reports it; only the orchestrator decides.
- Micro-patch: after fix round 2 the orchestrator may itself patch at most 10 lines, only if logged in the Model Trace and re-verified through Step 5. Otherwise, or if that check fails: save state and stop.
- Audit veto: a reproduced BLOCKER from any single auditor vetoes APPROVED. No majority vote or orchestrator override.
- Blind tests: the Step 4 Tester stays blind; its tests and their results go to the Step 5 auditors.
- Parent quota: preflight warns when the parent model's weekly quota is known and under 20%; it never changes the parent. Claude quota is read only with \`config.quota.claudeUsage\`.`;

function flagsText(config) {
  const providers = effectiveAllowlist(config).map(([provider, models]) =>
    `- \`--${provider.toLowerCase().replace(/\s+/g, '-')}-only\`: restrict all steps and failovers to allowlisted ${provider} models (${models.join(', ')}).`);
  return `## Inline flags
Parse all leading \`--*\` flags before routing.

Rigor and flow
- \`--fast\`: cap complexity at L1 (no planning, blind tests or dual audit).
- \`--strict\`: force L3 rigor (plan cross-check, blind edge-case tests, parallel dual audit).
- \`--plan-only\`: stop after Step 2 and present the plan; no code edits.
- \`--dry-run\`: run Step 0 and Step 1 (REPO_BRIEF), then output the planned routing table; no planning or edits.
- \`--audit-only\`: skip Steps 2-3; Step 1 + Step 5 against the uncommitted diff, then Step 6 as needed.
- \`--resume\`: continue from .claude/auto-build-state.json, skipping completed waves.
- \`--commit\`: after Step 7, stage and commit (conventional message) only if tests pass and the audit is APPROVED.

Token and verification
- \`--no-audit\`: skip the Step 5 code audit (tests/lint still run unless --no-tests).
- \`--no-tests\`: skip Step 4 blind tests and the Step 5 test suite (copy, CSS, config edits).
- \`--budget\`: minimum-quota routing (Tier 1 / low effort where possible, Tier 2 low for L1-L3 builds, mid-tier auditors at medium).

Provider and cooldown
- \`--reset-cooldowns\`: run \`t3-auto-build quota clear --all\` before routing.
${providers.join('\n')}`;
}

function cooldownsText(config, configDir) {
  const scarce = config.models.filter((model) => model.scarceQuota)
    .map((model) => `${model.provider}:${model.model} [${model.pool ?? 'standard'}]`);
  return `## Cooldowns
File: \`${displayPath(configDir, COOLDOWN_FILE)}\` (shared across threads)
Scarce pools (overflow/escalation only): ${scarce.join(', ') || 'none'}

Keys: \`model:<id>\` (all hostings) | \`model:<provider>:<id>\` (that hosting) | \`provider:<p>\` | \`tier:<p>:<pool>\` (pools standard, fable, astra, third-party-claude; legacy \`tier:<p>:heavy\` is still read).
Entry: \`{ "scope": "model|provider|tier", "window": "burst|5h|weekly|custom", "until": "<ISO-8601 UTC>", "reason": "<short>", "source": "<who>" }\`. Legacy \`scope\` + \`until_utc\` entries are still read.
An unexpired entry removes every model it covers. Never retry or override it, except for the canary below.

- Plan error (not in plan, not entitled, unknown model): no cooldown; \`t3-auto-build availability mark <provider:model> plan-restricted --ttl 24h\`, then advise \`t3-auto-build sync-models\`.
- Quota is read by preflight: ladders come back ordered by pace (remaining % against time left to reset; scarce pools last, unknown keeps ladder order). A window at or below ${config.quota?.minRemainingPct ?? 3}% locks until its reset. Cache: \`${displayPath(configDir, 'auto-build-quota.json')}\`.
- Readers: Codex (\`codex app-server\`, experimental), Antigravity (\`agy -p /usage\`), Claude only with \`config.quota.claudeUsage\` or \`--claude-usage\` (\`claude -p\` creates session directories). A failed read is unknown.
- After a quota error: \`t3-auto-build quota check <provider:model> --on-error\` re-reads. Action \`retry\` (reset under 2 min away; it already waited): retry once. Action \`failover\`, or the same error again: next ladder entry. With no window at or below the threshold it writes a burst lock on that pool only (\`tier:<provider>:<pool>\`, ${Math.round((config.quota?.burstLockMs ?? 300000) / 60000)} min; \`burstLockMs\` 0 writes none).
- Manual lock, for a longer limit it did not record: \`t3-auto-build quota set <provider|model|provider:model> --burst|--5h|--weekly\`. --burst (429, transient, about 10 min): the model. --5h or --weekly: the provider; only a scarce pool capped: add \`--pool <pool>\`.
- CLI not on PATH: write the entry yourself with \`source: "orchestrator"\` (reset time from the error, else +10 min / +5 h / +7 days).

### recheck-via-t3 canary
For \`recheck-via-t3: <provider> (<model>)\` (skip under --dry-run, or when a --*-only flag excludes the provider):
1. Note the \`until\` of the provider lock and of every \`tier:<provider>:<pool>\` lock (\`t3-auto-build quota status\`).
2. \`t3-auto-build quota clear provider:<provider>\`.
3. Restore each pool lock: \`t3-auto-build quota set <provider> --pool <pool> --until <noted until>\`.
4. Send one canary \`delegate_task\` (that provider and model, low effort, prompt \`Reply with one word: ok\`).
5. Only on a rate or usage limit: \`t3-auto-build quota set <provider> --until <noted until, or a later reset from the error>\`. Any other outcome leaves it cleared.`;
}

function stateText(configDir) {
  return `## Run state
File: \`.claude/auto-build-state.json\` in the project. Runs that edit code, plus --plan-only, overwrite it after each wave/step:
\`{"flags":[],"completedWaves":[],"modifiedFiles":[],"remaining":[],"blockers":[]}\`
\`remaining\` names each pending wave/step and its files. Keep the file gitignored: if \`git check-ignore -q\` fails on it, append its path to the file printed by \`git rev-parse --git-path info/exclude\`.

--resume: restore \`flags\` (newly typed flags win), skip \`completedWaves\`, keep \`modifiedFiles\` in this run's diff scope, continue with \`remaining\` and \`blockers\` (rebuild REPO_BRIEF first). Missing or invalid file: say so and stop.

Ledger: \`${displayPath(configDir, LEDGER_FILE)}\`; \`t3-auto-build trace record --step <name> ...\` per step, and \`--step run\` once per run (\`stats\` counts runs by it).`;
}

/** Reference text for one topic, with this installation's paths and models. */
export function getReference(topic, { configDir = resolveTarget() } = {}) {
  if (!REF_TOPICS.includes(topic)) {
    throw new CliError(`unknown ref topic "${String(topic).slice(0, 40)}"; use ${REF_TOPICS.join(', ')}`, 2);
  }
  const config = loadConfig(configDir);
  const sections = {
    flags: () => flagsText(config),
    cooldowns: () => cooldownsText(config, configDir),
    state: () => stateText(configDir),
    rules: () => RULES,
  };
  const wanted = topic === 'all' ? Object.keys(sections) : [topic];
  const body = wanted.map((name) => sections[name]()).join('\n\n');
  return topic === 'all' ? `Config: \`${displayPath(configDir, CONFIG_FILE)}\`\n\n${body}` : body;
}

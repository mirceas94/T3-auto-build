import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CATALOG, resolveTiers, toConfig } from '../lib/plans.mjs';
import { getReference } from '../lib/ref.mjs';
import { renderSkill } from '../lib/render.mjs';
import { sandbox, write } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const template = read('skills/auto-build/SKILL.md.tmpl');
const v1 = JSON.parse(read('presets/tri-provider.json'));
const v2 = toConfig(resolveTiers({ claude: 'ultra', codex: 'pro-200', antigravity: 'pro' }), { preset: 'custom' });

for (const [name, config] of [['v1 preset', v1], ['v2 resolved', v2]]) {
  test(`renders ${name} with the v2 runtime rules`, () => {
    const skill = renderSkill(template, config, path.join(root, '.claude'));
    assert.doesNotMatch(skill, /\{\{|\}\}/);
    assert.match(skill, /t3-auto-build check-models/);
    assert.match(skill, /t3-auto-build availability mark <provider:model> plan-restricted --ttl 24h/);
    assert.ok(skill.includes(`at most ${config.maxParallelBuilders ?? 2} builders in parallel`));
    assert.match(skill, /auto-build-availability\.json/);
    assert.match(skill, /t3-auto-build quota check <provider:model> --on-error/);
  });
}

// v1 configs have no scarce models, so only the v2 render can name one.
test('v2 render names the cross-hosted scarce model', () => {
  assert.match(renderSkill(template, v2, root), /antigravity:claude-opus-5-5/);
});

// The budget covers the default install render; tier renders grow with their model lists.
test('rendered SKILL.md for the default install stays within 6144 bytes', () => {
  const size = Buffer.byteLength(renderSkill(template, v1, path.join(os.homedir(), '.claude')), 'utf8');
  assert.ok(size <= 6144, `${size} bytes`);
});

const FLAGS = [
  'fast', 'strict', 'plan-only', 'dry-run', 'audit-only', 'resume', 'commit', 'no-audit', 'no-tests', 'budget',
  'reset-cooldowns', 'claude-only', 'codex-only', 'antigravity-only',
];

test('every core flag and pipeline step survives in SKILL.md or the ref text', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), v2);
  const skill = renderSkill(template, v2, box.target);
  const both = `${skill}\n${getReference('all', { configDir: box.target })}`;
  for (const flag of FLAGS) assert.match(both, new RegExp(`--${flag}(?![\\w-])`), flag);
  // The steps are the skill's own: each starts a line (or heading) with its number.
  for (const step of ['0', '1', '2', '3', '3\\.5', '4', '5', '6', '7']) {
    assert.match(skill, new RegExp(`^(?:#+ )?(?:Step )?${step}(?!\\d|\\.\\d)`, 'm'), `step ${step}`);
  }
  for (const needed of [
    'REPO_BRIEF', 'Handoff Packet', 'Cross-Check', 'Diff Guard', 'Blind', 'VERDICT: APPROVED', 'VERDICT: REJECTED',
    'BLOCKER', 'COMMIT_MSG', 'Model Trace', 'Model used:', 'recheck-via-t3', 't3-auto-build preflight', 'auto-build-state.json',
    'quota check <provider:model> --on-error', 'auto-build-quota.json', '--claude-usage',
  ]) assert.ok(both.includes(needed), needed);
});

test('template and core CLAUDE.md hardcode no roster model ids', () => {
  for (const source of [template, read('core/CLAUDE.md')]) {
    assert.doesNotMatch(source.replace(/\{\{[^{}]*\}\}/g, ''), /gpt-\d|gemini-\d|claude-(haiku|sonnet|opus|fable)/i);
  }
});

test('orchestration rules are in the skill and detailed in ref rules', (t) => {
  const box = sandbox(t);
  write(box.path('auto-build.config.json'), v2);
  const skill = renderSkill(template, v2, box.target);
  const rules = getReference('rules', { configDir: box.target });
  for (const [inSkill, inRef] of [
    [/every Handoff Packet:.*role\+isolation rules \([^)]*\/auto-build-rules\.md\)/, /repo-profile\.md\. Every Handoff Packet \(builder, tester, auditor, architect\) includes them\./],
    [/test\/lint, conventions, isolation/, /Triage records/],
    [/shared: wave 1; parallel builders change them only if you decide/, /only the orchestrator decides/],
    [/never silently self-edit \(except Step 6 micro-patch\)/, /at most 10 lines/],
    [/After R2: your <=10-line micro-patch only if logged in Model Trace \+ Step 5 re-verified; else save state, stop/, /save state and stop/],
    [/Any auditor's reproduced BLOCKER vetoes APPROVED \(no majority\/override\)/, /vetoes APPROVED.*For an unmet requirement, reproduced means the quote is in the task and the diff does not meet it\./],
    [/Auditors get Step 4 tests\+results/, /Step 4 Tester stays blind/],
    [/signatures\/role\+isolation rules; no production edits/, /Tester: take expected values/],
    [/Triage \(Tier 1 low; give it rules file\)/, /every Handoff Packet, and the Triage prompt, also carries the lines below that name its role/],
    [/Send the task, only run's `git diff -U5`/, /Auditor: check the task as given.*missing, unrequested or wrongly built/],
    [/or quoted unmet requirement/, /unmet or wrongly built requirement is a BLOCKER: quote it/],
    [/Resolve `UNVERIFIED:` \(rules file\) before accepting APPROVED/, /Still unsettled: list it under `Not checked:`/],
    [/interfaces\+callers/, /marks the rest `unverified`/],
    [/crypto \+ rules-file triggers/, /also L3: changes to untrusted-input parsing, filesystem path resolution, outbound network calls or secret handling/],
  ]) {
    assert.match(skill, inSkill);
    assert.match(rules, inRef);
  }
  for (const delegateRule of [
    /Builder: reuse code\/stdlib, no speculative abstractions.*`COMMIT_MSG:`/,
    /Fixer \(whoever edits in Step 6, R1 Builder or R2 Architect; plus the Builder line\): before editing, run one command that fails on the exact symptom/,
    /Tester: take expected values from the task.*never recompute them/,
    /Builder claims and justifications are unverified/,
    /start no subagents or reviewers/,
  ]) assert.match(rules, delegateRule);
  assert.match(rules, /config\.quota\.claudeUsage/);
});

test('every tier combination renders within 6144 bytes', () => {
  const dir = path.join(os.homedir(), '.claude');
  const [claude, codex, antigravity] = ['claude', 'codex', 'antigravity'].map((provider) => [
    ...new Set(['none', ...Object.keys(CATALOG[provider])]),
  ]);
  for (const c of claude) for (const x of codex) for (const a of antigravity) {
    let config;
    try {
      config = toConfig(resolveTiers({ claude: c, codex: x, antigravity: a }, { allowUsageCredits: true }), { preset: 'custom' });
    } catch (error) {
      if (/no CLI-capable subscription/.test(error.message)) continue; // nothing to render
      throw error;
    }
    const size = Buffer.byteLength(renderSkill(template, config, dir), 'utf8');
    assert.ok(size <= 6144, `${c}/${x}/${a}: ${size} bytes`);
  }
});

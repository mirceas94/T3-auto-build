# t3-auto-build

<p align="center"><img src="https://raw.githubusercontent.com/mirceas94/t3-auto-build/main/assets/banner.svg" alt="t3-auto-build: subscription-aware multi-model routing with safety guards across Codex, Antigravity and Claude" width="100%"></p>

<p align="center">Cross-platform installer and <code>$auto-build</code> orchestration suite for T3 Code.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/t3-auto-build"><img src="https://img.shields.io/npm/v/t3-auto-build" alt="npm version"></a>
  <a href="https://github.com/mirceas94/t3-auto-build/actions/workflows/ci.yml"><img src="https://github.com/mirceas94/t3-auto-build/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.18-brightgreen" alt="Node 18.18 or newer">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license">
</p>

## Why t3-auto-build

`t3-auto-build` equips T3 Code (and Claude Code) with subscription-aware multi-model routing and
safety guardrails: a coding-discipline `CLAUDE.md`, reusable slash commands (`/fix`, `/review`,
`/handover`), an `auto-build` skill rendered from your own model config, and self-contained Node.js
hooks.

- **Subscription profiles:** tell `init` your Claude, Codex and Antigravity plans; models, ladders and parallelism follow.
- **Parallel waves:** larger tasks are split into file-disjoint waves with checks between them.
- **Guardrails:** hooks block secret-file edits, destructive Git/`rm` commands, and disallowed `delegate_task` calls.
- **Quota aware:** cooldown locks and an availability cache keep delegation away from exhausted or restricted models.
- **Careful installs:** your edited files are kept unless you pass `--force`, which backs them up first.
- **Zero dependencies:** plain Node, 18.18 or newer.

Upgrading from 1.x? Read [Migrating from v1](#migrating-from-v1) and the [changelog](CHANGELOG.md).

## Table of Contents

- [Quick Start](#quick-start)
- [Subscription tiers](#subscription-tiers)
- [Availability checks](#availability-checks)
- [Model bans](#model-bans)
- [Speed-mode guard](#speed-mode-guard)
- [auto-build workflow](#auto-build-workflow)
- [CLI](#cli)
- [Legacy presets](#legacy-presets)
- [Migrating from v1](#migrating-from-v1)
- [sync-models](#sync-models)
- [Quota](#quota)
- [Configuration](#configuration)
- [What `init` touches](#what-init-touches)
- [Hooks](#hooks)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting & Common Gotchas](#troubleshooting--common-gotchas)
- [Optional tools](#optional-tools)
- [Development](#development)
- [License](#license)

## Quick Start

### New install

1. Install into your Claude config directory, naming your plans (see the [tier matrix](#subscription-tiers)):

   ```sh
   npx t3-auto-build@2.1.2 init --claude-tier max --codex-tier plus --antigravity-tier pro --yes
   ```

   Plain `npx t3-auto-build@2.1.2 init` asks instead. From a clone, use `node bin/cli.mjs` in place
   of `npx t3-auto-build@2.1.2`. `init` prints what it resolved:

   ```text
   provider    | tier | CLI | models (standard)                                    | scarce overflow                    | max parallel
   claude      | max  | yes | claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5 | -                                  | 2
   codex       | plus | yes | gpt-6-luna, gpt-6.1-terra                            | -                                  | 1
   antigravity | pro  | yes | gemini-4-hydrogen, gemini-4-neon, gemini-4-carbon    | claude-sonnet-5-5, claude-opus-5-5 | 2
   parent: opus (medium)
   max parallel builders: 5
   ```

   > `init --yes` **without** a tier flag on a fresh directory writes a legacy v1
   > [preset](#legacy-presets) config, not a subscription profile.

2. Verify the installation:

   ```sh
   npx t3-auto-build@2.1.2 doctor
   ```

3. Fill the `12h` availability cache (probes run only when the cache is stale; see
   [Availability checks](#availability-checks)):

   ```sh
   npx t3-auto-build@2.1.2 check-models
   ```

4. **Restart T3 Code** (and any running Claude Code session). Hooks and `settings.json` changes
   load only at startup.

5. In a T3 Code thread, run `$auto-build <task>`. See [workflow](#auto-build-workflow) for flags.

### Upgrade & read-only inspection

Upgrade a legacy v1 config to v2:

```sh
npx t3-auto-build@2.1.2 upgrade
```

Verify your installation, hooks, config, and optional tools:

```sh
npx t3-auto-build@2.1.2 doctor
```

Read-only inspection commands (no config writes, no live probes):

- Active quota cooldown locks:

  ```sh
  npx t3-auto-build@2.1.2 quota status
  ```

- Availability cache age, model status, and drift counts:

  ```sh
  npx t3-auto-build@2.1.2 availability status
  ```

- Preview model drift promotions without probing or writing:

  ```sh
  npx t3-auto-build@2.1.2 sync-models --apply --dry-run
  ```

The skill calls `t3-auto-build ...`. From a clone, `npm link` puts that command on `PATH`.
Without it the skill reads the cooldown and availability files directly.

## Subscription tiers

Pass one or more of `--claude-tier`, `--codex-tier`, and `--antigravity-tier`. When setting tiers,
an omitted provider defaults to `none` on a fresh install, keeps its tier on a v2 config, and gets
the [assumed tier](#migrating-from-v1) on a v1 config. At least one provider needs a CLI-capable
tier.

| Provider | Tier | CLI | Standard models | Scarce overflow | Max parallel | Warning |
|---|---|---|---|---|---|---|
| claude | `none` | no | – | – | 0 | no Claude subscription selected |
| claude | `free` | no | – | – | 0 | Claude Code requires Pro or higher (or api) |
| claude | `pro` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | – | 1 | – |
| claude | `max` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | – | 2 | – |
| claude | `ultra` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | `claude-fable-5-2` | 3 | – |
| claude | `team-standard` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | – | 1 | – |
| claude | `team-premium` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | – | 2 | – |
| claude | `api` | yes | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | `claude-fable-5-2` | 3 | API usage is billed per token |
| codex | `none` | no | – | – | 0 | no Codex subscription selected |
| codex | `free` | yes | `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna` | – | 1 | – |
| codex | `go` | yes | `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna` | – | 1 | – |
| codex | `plus` | yes | `gpt-6-luna`, `gpt-6.1-terra` | – | 1 | – |
| codex | `pro-100` | yes | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | 2 | – |
| codex | `pro-200` | yes | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | 2 | – |
| codex | `pro-500` | yes | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | 3 | – |
| codex | `business` | yes | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | 2 | – |
| codex | `api` | yes | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` | `gpt-6-astra` | 3 | API usage is billed per token |
| antigravity | `none` | no | – | – | 0 | no Antigravity subscription selected |
| antigravity | `free` | yes | `gemini-4-hydrogen`, `gemini-4-neon` | – | 1 | – |
| antigravity | `plus` | yes | `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon` | – | 1 | – |
| antigravity | `pro-trial` | yes | `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon` | – | 1 | – |
| antigravity | `pro` | yes | `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon` | `claude-sonnet-5-5`, `claude-opus-5-5` | 2 | – |
| antigravity | `ultra-5x` | yes | `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon` | `claude-sonnet-5-5`, `claude-opus-5-5` | 2 | – |
| antigravity | `ultra-20x` | yes | `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon` | `claude-sonnet-5-5`, `claude-opus-5-5` | 3 | – |

- Resolved parallelism is the sum over eligible providers, capped at 6. Builder counts and quota
  windows are estimates.
- `api` tiers are billed per token. Their models are excluded (and listed as plan-restricted)
  unless you pass `--allow-usage-credits`.
- Ladders use native standard models first, interleaving providers. Scarce models come last, as
  overflow or escalation.

### Parent model

The parent is the model of the orchestrating Claude session. It needs an eligible Claude tier.

| Claude tier | Default parent / effort | `--parent` options |
|---|---|---|
| `pro`, `team-standard` | `sonnet` / `medium` | `sonnet`, `opus` |
| `max`, `team-premium` | `opus` / `medium` | `sonnet`, `opus` |
| `ultra`, `api` | `opus` / `medium` | `sonnet`, `opus`, `fable` |

An `api` tier counts only with `--allow-usage-credits`.

`--parent fable` selects `claude-fable-5-2`, from the scarce `fable` pool. `init` writes `model` and
`effortLevel` to `settings.json` only when the key is absent or still holds the value it wrote
before. Without an eligible Claude tier, no parent is set. This sets Claude Code's default session
model; in T3 Code you can still start a `$auto-build` thread on any allowlisted model (see
[Starting model](#starting-model)).

### Cross-hosted overflow

Antigravity `pro`, `ultra-5x` and `ultra-20x` also host `claude-sonnet-5-5` and `claude-opus-5-5`,
in the scarce pool `third-party-claude`.

- Reach them in `delegate_task` only with an explicit `provider: "antigravity"` and the unprefixed
  model ID (in config ladders, written as `antigravity:claude-opus-5-5@medium`).
- A bare `claude-*` model always resolves to native Claude, never to Antigravity.
- A model the named provider does not host, or two different providers in one call, is blocked.

## Availability checks

The skill runs `t3-auto-build check-models` at the start of every run. Results go to
`<config dir>/auto-build-availability.json`.

| Check | When | Cost |
|---|---|---|
| 1. Discovery: binary and `--version` check, plus your listing adapters | every `check-models` | no model calls |
| 2. Probes of standard-pool models | cache older than 12 h since the last probe, or `--refresh` | one short prompt per model |
| Scarce-pool probes | never, unless `--probe-scarce` is set and check 2 runs | real scarce quota |
| 3. Reactive marks: `availability mark` after a plan error | on demand | none |

> Probe processes inherit your environment. If an API key variable (such as `ANTHROPIC_API_KEY` or
> `OPENAI_API_KEY`) is set, the CLI may use it and the probes may be billed to the API.

- Probe results never block a model unless they say `plan-restricted`. A failed or timed-out probe
  blocks nothing. A manual mark of `plan-restricted` or `unavailable` blocks.
- A live manual mark beats discovery and probe results. Its `--ttl` is one number plus `m`, `h` or
  `d`, above zero and at most `30d` (default `24h`).
- Antigravity has no probe support.
- After its summary line, `check-models` prints one `provider:model status` line per configured model:
  `available` (nothing speaks against it), `rate-limited` (locked or limited), `plan-restricted`,
  `unavailable` or `skipped-scarce`.

Mark a model manually or inspect the cache:

```sh
t3-auto-build availability mark antigravity:claude-opus-5-5 plan-restricted --ttl 24h --reason "not in plan"
```

```sh
t3-auto-build availability status
```

### Lock rechecks

A lock lasting more than 6 hours gets `setAt` and `recheckAfter` (6 hours later). Once a provider lock
is past `recheckAfter`, or for every provider lock with `--recheck-locks`, `check-models` tests the
cheapest configured standard model:

- With a Claude or Codex CLI installed, it sends one probe. Success clears the lock; any other result
  moves `recheckAfter` 6 hours ahead.
- Otherwise (such as Antigravity) it prints `recheck-via-t3: <provider> (<model>)`. The skill then
  clears the lock, sends a one-word canary `delegate_task`, and re-locks only on a rate limit.

Model and pool locks are not rechecked.

```sh
t3-auto-build check-models --recheck-locks
```

### Model drift (safe by default)

Model discovery and drift adoption are conservative by default:

- **`12h` availability cache window:** `check-models` reuses cached probe results for `12h` and
  only re-probes standard-pool models once the cache ages past `12h` (or on `--refresh`). Scarce
  models are never probed unless you pass `--probe-scarce`.
- **Unknown models stay disabled until allowlisted:** Discovery adapters report newly seen IDs and
  missing configured models, but nothing is enabled automatically. Unknown model families stay
  disabled until you explicitly allowlist them in `auto-build.config.json`. Retired, user-banned,
  and plan-restricted IDs are never promoted.
- **Preview before applying:** Run `sync-models --apply --dry-run` first to review proposed
  same-family version upgrades without modifying `auto-build.config.json` or `SKILL.md` (and
  without running live probes).

No provider CLI listing is built in. To detect new or missing models, add an adapter per provider to
the config: an argv array whose stdout is a JSON array or a newline list of model ids.

```json
{ "discovery": { "codex": ["node", "<absolute path>/list-codex-models.mjs"] } }
```

`list-codex-models.mjs` is a placeholder for your own script. Adapters run in an empty temp
directory, so use absolute paths. `check-models` then reports IDs that are not configured and
configured native models the adapter did not list.

1. Refresh discovery and check for drift:

   ```sh
   t3-auto-build check-models
   ```

2. Preview same-family version promotions (no probes, no writes):

   ```sh
   t3-auto-build sync-models --apply --dry-run
   ```

3. Apply promotions (backs up config and re-renders `SKILL.md`):

   ```sh
   t3-auto-build sync-models --apply
   ```

`--apply` reads the availability cache and replaces a configured model with a newer version of the
same family, keeping its pool and ladder position, then backs up the config and re-renders
`SKILL.md`. It needs an `auto-build` or `full` install.

## Model bans

Three layers apply to `delegate_task` calls.

| Layer | Source | Can you remove it? |
|---|---|---|
| Retired | built in, plus `retiredModels` | Not the built-in entries. Config can only add. |
| Plan-restricted | `planRestrictedModels` (`provider:model` or bare model) and live availability entries | Change tiers, or let the mark expire or replace it |
| User-banned | `userBannedModels` / `bannedModels` | Yes — remove from both lists in `auto-build.config.json`, then re-run `init` |

Built-in retired patterns: `gemini-4-argon`, `gemini-3.8-flash`, `claude-4.6`, `claude-4.6-*`,
`gpt-5.4`, `gpt-5.4-*`, `gpt-5.5`, `gpt-5.5-*`. Matching treats `.` and `-` alike, accepts display
names (`GPT 5.4 Mini`) and ignores a trailing date. A `-*` pattern covers the stem and its suffixed
variants; `gpt-5.40` does not match `gpt-5.4`.

User bans match as case-insensitive substrings, and `A/B` bans both. A short entry such as `Claude`
bans every model whose name contains it.

## Speed-mode guard

Unless the config has `"allowFastModes": true`, a `delegate_task` call is blocked when a key matching
`fast`, `speed` or `serviceTier` is `true`, `fast`, `ultrafast` or `priority`. Set it with
`init --allow-fast-modes`.

## auto-build workflow

Triage sizes the task, `L2`/`L3` plan and build in waves (foundations, core, tests/docs), then verification runs with at most 2 fix rounds.

```mermaid
flowchart TD
  S["$auto-build<br/>request"] --> S0["Step 0<br/>check-models &amp; locks<br/>git baseline / resume"]
  S0 --> T["Triage<br/>REPO_BRIEF<br/>level &amp; shape"]
  T -->|"L0 / L1"| B1["Single builder"]
  T -->|"L2 / L3"| P["Plan<br/>L3 cross-check"]
  P --> W1["Wave 1<br/>foundations"]
  W1 --> W2["Wave 2<br/>core"]
  W2 --> W3["Wave 3<br/>tests &amp; docs"]
  B1 --> V["Verify<br/>tests, lint<br/>diff audit"]
  W3 --> V
  V -->|"blockers"| F["Fix round<br/>(max 2)"]
  F --> V
  V -->|"passed"| R["Optional commit<br/>&amp; report"]
```

1. **Step 0:** run `t3-auto-build check-models` (`12h`-cached availability and lock rechecks) and
   `t3-auto-build quota status`, check lockouts and restrictions, record the `git status` baseline,
   and resume if asked.
2. **Triage:** write a short `REPO_BRIEF` (using the cached `.claude/repo-profile.md`) and pick the
   level `L0` to `L3` and work shape `A` (multi-file, UI) or `B` (algorithms, debugging).
3. **Plan** (`L2`/`L3`), cross-checked by another provider on `L3` when available.
4. **Build:** `L2`/`L3` run in file-disjoint waves: foundations, core, tests/docs. Builders in a wave
   run in parallel, at most `maxParallelBuilders` at once; the diff guard and exit checks pass before
   the next wave.
5. **Verify:** blind edge-case tests (`L2`/`L3`), tests and lint, a diff-only audit preferring
   another provider (two auditors on `L3`), at most 2 fix rounds, then an optional commit and a
   report.

- **Resumable state:** Runs that edit code (plus `--plan-only` runs) save
  `.claude/auto-build-state.json` (`flags`, `completedWaves`, `modifiedFiles`, `remaining`,
  `blockers`) after each wave or step and keep it gitignored.
- **Resuming & quota exhaustion:** `$auto-build --resume` restores saved state (newly typed flags
  win), skips completed waves, and stops if the file is missing or invalid. When quota runs out,
  state is saved so you can resume later.

| Flag | Effect |
|---|---|
| `--fast` / `--strict` | Cap at `L1` / force `L3`. |
| `--plan-only` | Stop after the plan. |
| `--dry-run` | Stop after triage and show the routing. |
| `--audit-only` | Test and audit the uncommitted diff, then fix if needed. |
| `--resume` | Continue an interrupted run. |
| `--commit` | Commit only if the active checks pass. |
| `--no-audit`, `--no-tests` | Skip the audit / tests. |
| `--budget` | Cheaper routing; no plan cross-check, blind tests or dual audit. |
| `--reset-cooldowns` | Clear all locks first. |
| `--<provider>-only` | Use only that provider's models (e.g. `--claude-only`, `--codex-only`, `--antigravity-only`). |

### Starting model

You can start a `$auto-build` conversation in T3 Code on **any allowlisted model** (for example
`gemini-4-neon`), not only the configured Claude [parent model](#parent-model). The starting model
acts as the orchestrator/coordinator: it runs triage, tracks waves and checks, and delegates
builders, testers, and auditors along the configured ladders rather than doing all edits itself.

Choose a starting model that fits the task and your active quotas (check `t3-auto-build check-models`
and `t3-auto-build quota status` to avoid models under active provider locks or plan/availability
restrictions):

| Goal / task type | Practical starting models |
|---|---|
| Saving primary quota, lightweight triage, or small tasks | `gemini-4-neon`, `gpt-6-luna` |
| General multi-file or UI orchestration | `claude-sonnet-5-5`, `gemini-4-neon` |
| Deeper debugging, architecture, or high-risk `L2`/`L3` coordination | `gpt-6.1-terra`, `gpt-6.1-sol`, `claude-opus-5-5`, `gemini-4-carbon` |

Two practical nuances to keep in mind:

- **Hook enforcement scope:** [`pre-tool-use.mjs`](#hooks) enforces model allowlist, ban,
  restriction, speed-mode, and cooldown guards on `delegate_task` calls (plus secret-file and
  destructive-command guards on `Edit`, `Write`, `MultiEdit`, and `Bash`), not on T3 Code's UI
  thread model picker. Choosing a non-allowlisted or locked model in the picker is not blocked by
  the hook itself; model guards trigger when `delegate_task` runs.
- **Follow-up messages without `$auto-build`:** Subsequent messages in the same thread that omit
  `$auto-build` follow the **Follow-Up Refinement Rule** rather than always launching a fresh full
  `$auto-build` pipeline—questions are answered directly from thread context, `L0` micro-tweaks
  take the fast single-builder path, and only substantive `L1`–`L3` changes re-run the full
  pipeline.

## CLI

```text
t3-auto-build init [options]
t3-auto-build upgrade [--yes]
t3-auto-build check-models [--refresh] [--probe-scarce] [--recheck-locks] [--json]
t3-auto-build sync-models [--auto] [--refresh] [--probe-scarce] [--apply] [--dry-run] [--providers <list>] [--force]
t3-auto-build availability mark <provider:model> <available|plan-restricted|unavailable> [--ttl 24h] [--reason <text>]
t3-auto-build availability status
t3-auto-build quota set <subject> [--pool <name>] [--burst|--5h|--weekly|--until <when>] [--reason <text>]
t3-auto-build quota status
t3-auto-build quota clear <subject> | --all
t3-auto-build quota check [provider]
t3-auto-build doctor
t3-auto-build uninstall
t3-auto-build --version | --help
```

| Command | What it does |
|---|---|
| `init` | Installs or updates. Interactive unless `--yes`. |
| `upgrade` | Converts a v1 config to v2. Never prompts. |
| `check-models` | Prunes expired state, runs discovery, probes if the cache is stale. |
| `sync-models` | Probes models and updates the allowlist, or applies drift with `--apply`. |
| `availability mark\|status` | Sets or shows model availability. |
| `quota set\|status\|clear\|check` | Manages cooldown locks. |
| `doctor` | Checks files, config, hook wiring and smoke tests, cache age, configured tiers against CLI binaries, drift and optional tools. |
| `uninstall` | Removes what `init` installed and the availability cache. Keeps files you changed and the cooldown file. |

| Option | Applies to | Meaning |
|---|---|---|
| `--target <dir>` | all | Config directory. Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `-h`, `--help` | all | Show the usage text. |
| `-v`, `--version` | no command | Print the version. |
| `--yes` | init, upgrade, sync-models | No prompts. Without an interactive terminal, `init` requires it, and `sync-models` (without `--apply`) requires it, `--auto` or `--dry-run`. |
| `--preset <name>` | init | `tri-provider`, `claude-codex` or `claude-only`. Legacy configs only. |
| `--modules <name>` | init | `full`, `auto-build` or `core`. |
| `--compaction <n>` | init | Integer from 1 to 100. |
| `--tiers <list>` | init | Legacy `provider:plan[:weekday]` list. Ignored for v2 configs. |
| `--claude-tier <tier>` | init | `none`, `free`, `pro`, `max`, `ultra`, `team-standard`, `team-premium`, `api`. |
| `--codex-tier <tier>` | init | `none`, `free`, `go`, `plus`, `pro-100`, `pro-200`, `pro-500`, `business`, `api`. |
| `--antigravity-tier <tier>` | init | `none`, `free`, `plus`, `pro-trial`, `pro`, `ultra-5x`, `ultra-20x`. |
| `--parent <model>` | init | `sonnet`, `opus` or `fable`. See [parent model](#parent-model). |
| `--allow-usage-credits` | init | Include per-token `api` tiers. Needs a tier or a v2 config. |
| `--allow-fast-modes` | init | Permit fast or priority service modes. Needs a tier or a v2 config. |
| `--verified-org` | init | Record `verifiedOrg: true` in a v2 config (informational metadata; not used by routing or hooks). |
| `--probe` | init | Run `sync-models` after installing. Spends real quota. Ignored for `core`. |
| `--force` | init, sync-models | Back up your changed files to `<file>.bak`, then overwrite. For `sync-models`, this covers a hand-edited `SKILL.md`. |
| `--refresh` | check-models, sync-models | Ignore the probe cache TTL. `sync-models` without `--apply` always probes. |
| `--probe-scarce` | check-models, sync-models | Also probe scarce-pool models. |
| `--recheck-locks` | check-models | Recheck every active provider lock now. |
| `--json` | check-models | Machine-readable result. |
| `--auto` | sync-models | Write without confirmation, like `--yes`. |
| `--apply` | sync-models | Promote newer versions from recorded drift. |
| `--dry-run` | sync-models | With `--apply`, preview drift promotions from the cache (no probes, no writes). Without `--apply`, run live probes (**spends real quota**) and print the result without writing. |
| `--providers <list>` | sync-models | Only these of `claude`, `codex`, `antigravity`; comma separated. |
| `--ttl <duration>` | availability mark | `1m` to `30d`, default `24h`. |
| `--pool <name>` | quota set | Lock a pool: `standard`, `fable`, `astra`, `third-party-claude`, or another lowercase name. |
| `--burst`, `--5h`, `--weekly`, `--until <when>` | quota set | Lock window; one only. Default `--burst`. |
| `--reason <text>` | quota set, availability mark | Note shown by the status command. |
| `--all` | quota clear | Remove every lock. |

Exit codes: `0` success (including informational `doctor` warnings), `1` failure (invalid JSON, broken install), `2` usage error.

```sh
t3-auto-build init --claude-tier pro --codex-tier plus --antigravity-tier pro --parent opus
t3-auto-build check-models --json
t3-auto-build sync-models --refresh --probe-scarce
t3-auto-build quota set antigravity:claude-opus-5-5 --pool third-party-claude
```

### Modules

| `--modules` | Name | CLAUDE.md, rules, commands | Skill, config, hooks, `settings.json` |
|---|---|---|---|
| `full` (default) | Full Suite | yes | yes |
| `auto-build` | /auto-build Only | no | yes |
| `core` | Core Discipline + Commands | yes | no (`settings.json` is not written) |

A re-run without `--modules` keeps the previous choice. When you change it, `init` removes the files
that no longer belong and keeps and reports the ones you changed. Switching to `core` also removes
the hook entries and the values `init` set in `settings.json`. That cleanup is the one case where a
`core` run writes `settings.json`.

## Legacy presets

Without subscription tiers, `init` writes a v1 config from a preset.

| Preset | Models | Codex | Antigravity | Claude | Dual audit |
|---|---|---|---|---|---|
| `tri-provider` (default) | 9 | 3 | 3 | 3 | Claude Opus 5.5 + Gemini 4 Carbon |
| `claude-codex` | 6 | 3 | 0 | 3 | Claude Opus 5.5 + gpt-6-luna |
| `claude-only` | 3 | 0 | 0 | 3 | Claude Opus 5.5 + Claude Sonnet 5.5 |

Every preset defaults to Claude Sonnet 5.5 at `medium` effort and sets the auto-compaction threshold
to 35%. Presets ban no models of their own; the [retired list](#model-bans) always applies.

Interactive `init` on a fresh target suggests tiers (Claude `pro`, Codex `plus`, Antigravity `plus`)
for the `claude`, `codex` and `antigravity` binaries on `PATH`. If you choose `none` everywhere, it
asks for a preset. Provider config folders are only checked for existence. `init --yes` does not
detect: a fresh install without `--preset` or a tier uses `tri-provider`.

`--tiers provider:plan[:weekday]` (for example `claude:max:monday,codex:plus`) records how limits are
shared in a v1 config.

| Provider | Plan: short-window limit locks the provider | Plan: locks only the scarce pool | Pool |
|---|---|---|---|
| `claude` | `pro` | `max` | `fable` |
| `codex` | `plus` | `pro` | `astra` |
| `antigravity` | `standard` | `ultra` | `third-party-claude` |

The weekday (`monday` or `mon`) is the weekly reset day, taken as 00:00 UTC.

## Migrating from v1

v1 configs keep loading, with the retired list enforced. To convert:

1. Run the `2.1.2` package:

   ```sh
   npx t3-auto-build@2.1.2 upgrade
   ```

2. `upgrade` assumes low paid tiers, because a v1 config does not say what you pay for: Claude `pro`,
   Codex `plus`, Antigravity `plus` for each provider in your allowlist, else `none`.
3. Set your real tiers:

   ```sh
   npx t3-auto-build@2.1.2 init --claude-tier max --codex-tier pro-200 --antigravity-tier pro
   ```

   Until then no scarce or cross-hosted model is configured.
4. Restart T3 Code.

What `upgrade` does:

- Backs up `auto-build.config.json` to `.bak` (`.bak.1` and so on if a different backup exists).
- Moves your `bannedModels` to `userBannedModels`, dropping the old defaults `Argon` and
  `Fable/Mythos`. `bannedModels` mirrors the list.
- Keeps `compactionThreshold`, `defaultEffort`, `modelIds` and `discovery`. Ladder entries still in
  the new roster stay in place; others are replaced.
- Rebuilds the rest from the tiers. Custom allowlist entries, `defaultModel`, `planRestricted` and
  `tiers` are not carried over.
- Re-renders the managed files you have not edited and updates `settings.json`, including `model` and
  `effortLevel` when absent.
- Does nothing on a config that is already v2.

Existing `tier:<provider>:heavy` cooldown keys are still read.

## sync-models

> **`sync-models --dry-run` (without `--apply`) executes live probes.** It spends real quota and
> writes nothing; the [API billing warning](#availability-checks) applies. To preview drift
> promotions without probing or writing, use `sync-models --apply --dry-run` (see
> [Model drift (safe by default)](#model-drift-safe-by-default)).

- **Candidates:** On a v2 config, probe candidates come only from your tier-bound `allowlist`
  (preset models are not merged in). On a legacy v1 config, candidates are the config `allowlist`,
  its `planRestricted` models, and the preset's models (`custom` uses `tri-provider`). Banned models
  and, without `--probe-scarce`, scarce models are not probed.
- **Probe execution:** Each candidate gets a one-word prompt through `claude -p` (tools disabled,
  safe mode, no session persistence) or `codex exec` (read-only, ephemeral, `--ignore-user-config`,
  `--ignore-rules`) in an empty temp directory with a 20 s timeout. Antigravity has no probe
  support: its models report `unavailable` and keep their current membership.

| State | Effect on the config |
|---|---|
| `available` | Kept in `allowlist` (on v1, also added from the preset/`planRestricted` and removed from `planRestricted`; on v2, tier-derived `planRestrictedModels` are never lifted by a probe). |
| `rate-limited` | Same as `available`, plus a cooldown (preserving the longest reset time per key across the run). After a provider-wide limit the remaining models of that provider are skipped; a skipped model already in `planRestricted` stays there. |
| `plan-restricted` | Removed from `allowlist` and added to `planRestrictedModels` as `provider:model` (v2) or moved to `planRestricted` (v1). |
| `unavailable` | No change (CLI missing, not logged in, timeout, unsupported or other failure). |

- **Confirmation & backups:** Without `--yes` or `--auto`, `sync-models` (without `--apply`) shows
  the changes and asks before writing. Writes back up a changed config, re-render `SKILL.md`, and
  record cooldowns without shortening longer ones.
- **Safety guards:** A hand-edited `SKILL.md` is skipped with a warning (`--force` backs it up and
  overwrites it). An emptied ladder gets a fallback model; if no allowed model would remain,
  nothing is written.
- **Install scope:** Writing needs an `auto-build` or `full` install; `--dry-run` needs only the
  config file. `init --probe` runs `sync-models --yes` automatically after installing.

## Quota

```sh
t3-auto-build quota set <provider|model|provider:model> [--pool <name>] [--burst|--5h|--weekly|--until <when>] [--reason <text>]
t3-auto-build quota status
t3-auto-build quota clear <provider|model|provider:model>   # or --all
t3-auto-build quota check [provider]
```

- `set claude` locks the provider; `set claude-opus-5-5` locks that model on every hosting;
  `set antigravity:claude-opus-5-5` locks that hosting only. With `--pool`, any of these locks that
  pool of the provider instead (a bare model means its native provider).
- The default `--burst` is 10 minutes; `--5h` is 5 hours; `--weekly` runs to a legacy tier's reset
  day, else 7 days. `--until` takes a future ISO time or a duration such as `90m` or `1w2d`.
- In a v1 config whose `--tiers` plan locks only the scarce pool, `--5h` on a provider locks that
  pool.
- Reset times parsed from rate-limit messages honor explicit `UTC`/`GMT`/`Z` clock suffixes and are
  capped at 14 days. A manual `--until` is not capped.
- `status` drops expired locks and prints the rest.
- `clear <provider>` (or `clear provider:<provider>`) removes its provider and pool locks, not its
  model locks. `clear <model>` removes that model's lock; `clear <provider:model>` removes that
  hosting's model lock (and any matching unqualified model lock). `--all` deletes the file, even a
  corrupt one.
- `check` runs `claude auth status` and `codex login status` (Antigravity has no status command). It
  reports login state only, unless the output explicitly says usage is exhausted; only then does it
  record a lock.

### Cooldown file

`<config dir>/auto-build-cooldowns.json` is a JSON object with these keys:

| Key | Locks |
|---|---|
| `model:<id>` | The model on every hosting. |
| `model:<provider>:<id>` | That hosting (or custom instance, such as `model:codex-2:<id>`) only. |
| `provider:<p>` | The provider (or custom instance). Canonical `provider:codex` also covers `codex-2`; `provider:codex-2` covers only `codex-2`. Locking `claude` does not block `antigravity:claude-opus-5-5`. |
| `tier:<p>:<pool>` | One pool (`[a-z0-9-]+`), such as `tier:antigravity:third-party-claude`. Custom instance keys (`tier:codex-2:<pool>`) stay isolated to that instance and do not leak to `codex`. |

On v2 configs, `quota check` and probes write `tier:<p>:<pool>` keys (using `heavy` only for legacy
v1 configs or providers without a named scarce pool). Legacy `tier:<p>:heavy` keys are still read
and are gated on provider match so they never leak across hosts.

```json
{
  "tier:codex:astra": {
    "scope": "tier",
    "tier": "astra",
    "window": "weekly",
    "until": "2030-01-01T05:00:00.000Z",
    "reason": "manual lock (weekly)",
    "source": "manual"
  }
}
```

- **Fields:** `scope` is `model`, `provider` or `tier`; `window` is `burst`, `5h`, `weekly` or
  `custom`. Legacy `until_utc` is read.
- **Long locks & keys:** Locks lasting more than 6 hours also carry `setAt` and `recheckAfter` (see
  [lock rechecks](#lock-rechecks)). A key without a prefix needs a `scope` field, or it locks
  nothing.
- **Malformed data:** A malformed entry (such as one without a valid time) is skipped with a warning
  and kept until overwritten or cleared (`quota clear <name>` or `--all`). A file that is not a JSON
  object is unreadable: hooks warn and ignore it.
- **Cleanup:** A write that leaves no entries removes the file.

## Configuration

`<config dir>/auto-build.config.json`. A v2 config has `schemaVersion: 2` and:

| Keys | Meaning |
|---|---|
| `subscriptions`, `parent`, `preset` | Your tiers, parent model and effort, and a label. |
| `models` | `provider`, `model`, `pool`, `scarceQuota`, `family`, `version` per hosting. |
| `allowlist`, `ladders` | Provider to model ids; ordered `[provider:]model[@effort]` lists (`tier1`, `commandRunner`, `builderA`, `testerA`, `auditorA`, `builderB`, `testerB`, `auditorB`, `architect`, `dualAudit`). |
| `retiredModels`, `planRestrictedModels`, `userBannedModels`, `bannedModels` | See [Model bans](#model-bans). |
| `allowFastModes`, `allowUsageCredits`, `verifiedOrg` | Switches, `false` by default. |
| `maxParallelBuilders`, `defaultModel`, `defaultEffort`, `compactionThreshold` | Run settings. |
| `modelIds`, `discovery` | Display name to CLI id; drift adapters. |

A v1 config has no `schemaVersion` and may also use `tiers` and `planRestricted`.

- The existing file is always the base. Re-run `init` after editing to re-render the skill. The hooks
  read the file when they need it.
- Changing tiers (or usage credits) rebuilds `models`, `allowlist` and `ladders`, after a backup. It
  keeps your bans, switches, threshold, effort, `modelIds` and `discovery`.
- `--compaction` overrides the file. In a v1 config, a `--preset` that differs from the file's
  replaces the allowlist, ladders and default model and effort. Banned models typed at the prompt are
  added.
- To start over, delete the file and run `init`.
- Model names ignore case and punctuation runs, so `claude-sonnet-5-5` matches `Claude Sonnet 5.5`.
  Provider cooldowns match the provider name or the T3 provider id (`claudeAgent`, `codex`,
  `antigravity`). `provider:codex` also covers a custom instance such as `codex-2`;
  `provider:codex-2`, `tier:codex-2:<pool>` and `model:codex-2:<id>` cover only that instance.
- Keys missing from the file come from its `preset` (`tri-provider` when unset or `custom`). The
  hooks fall back to full defaults on an unknown `schemaVersion`.
- Rendering drops banned and non-allowlisted ladder entries. If a ladder ends up empty, `init` fails
  and writes nothing.
- The skill gets one `--<provider>-only` flag per allowlisted provider.

## What `init` touches

- **Managed files** (in `<config dir>`):
  - **Core (`full`, `core`):** `CLAUDE.md`, `rules/code-quality.md`, `commands/fix.md`, `commands/review.md`, `commands/handover.md`.
  - **Auto-build (`full`, `auto-build`):** `skills/auto-build/SKILL.md`, `auto-build.config.json`, `hooks/t3-auto-build/{session-start,pre-compact,pre-tool-use,post-tool-use,_shared,_quota}.mjs`, and `settings.json`.
  - **Manifest (all modules):** `t3-auto-build.manifest.json`.
- Files that exist and differ from what was installed are skipped with a warning. This includes hook
  files, which are still wired. `--force` backs them up first (`.bak`, then `.bak.1`, so an earlier
  backup is never overwritten).
- `settings.json`: only the four tagged hook entries, `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and, with
  a parent model, `model` and `effortLevel`. Other keys and hooks are preserved. `settings.json.bak`
  is written only when the content changes. Invalid JSON stops the run before any write.
- Paths that go through a symlink or junction inside the config directory are not written or
  deleted. A symlinked `settings.json` is updated through the link.
- `t3-auto-build.manifest.json` records installed file hashes and prior setting values. `uninstall`
  restores a value only if it is still the one installed.
- A target path containing `"`, `$`, a backtick or `%` is refused, because it cannot be quoted
  safely in a hook command.

## Hooks

Installed to `<config dir>/hooks/t3-auto-build/`. Tool and property matching is case-insensitive.

| Hook | Event | Behavior |
|---|---|---|
| `session-start.mjs` | SessionStart | Prints up to 6 lines: subscriptions (or an upgrade hint), active locks, cache freshness, drift counts. Prunes expired cooldowns. |
| `pre-compact.mjs` | PreCompact | Prints the preservation rules (allowlist, bans, restrictions, scarce pools, locks), the saved orchestrator state if present (marked as data only, not instructions), and a `git status --short` snapshot (20 files at most). |
| `pre-tool-use.mjs` | PreToolUse | Exits 2 with a reason when a guard below matches. |
| `post-tool-use.mjs` | PostToolUse | Formats the edited file with `biome` or `prettier` (`.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.css`, `.md`), `ruff` (`.py`), or `gofmt` (`.go`) when on `PATH`. Never blocks. |

PreToolUse guards:

- **Invalid payload:** a named tool whose `tool_input` is present but not an object is blocked.
- **Secret files** (`Edit`, `Write`, `MultiEdit`): `.env` and `.env.*`, `.pem`, `.key`, `.p12`,
  `.pfx`, and paths containing `id_rsa` or `id_ed25519`.
- **Git** (`Bash`): `git push --force`/`-f` and `git reset --hard`.
- **Recursive `rm`** (`Bash`; `-r`, `-rf`, `-fr`, `-r -f`, `--recursive`; `-f` not required): blocked
  when a target starts with `/`, `\`, `~`, a drive path such as `C:/`, `$HOME` or `%USERPROFILE%`;
  contains a command substitution; is the current directory or `*`; has a `..` or `.git` segment; or
  is a dot-file glob such as `.*`.
- **Delegate calls** (`delegate_task`), in order: [speed mode](#speed-mode-guard), provider/model
  conflict, retired, user-banned, plan-restricted, availability, per-provider allowlist (a trailing
  `-YYYYMMDD` suffix is ignored), then cooldown locks.

Empty or unparsable hook input, and unreadable cooldown data, produce exit 0 (fail open). An invalid
config value produces a warning and a default, so the allowlist is still enforced. The secret and
destructive-command guards need no config.

### Known limits

- The command guards cover the `Bash` tool only and use simple patterns. They are a safety net, not a
  sandbox.
- The `rm` guard matches text. Obfuscated `rm`, PowerShell removal commands such as `Remove-Item`, and
  `find -delete` are **not** caught. Other variables are not expanded. Harmless text can match:
  `echo rm -rf .` is blocked. A very long command with many `rm` calls is blocked unchecked; split it up.
- Any `-f` text after `git push` matches, including a branch name such as `bug-fix`.
  `--force-with-lease` is blocked too.
- The delegate guard reads `model` and the provider fields (`provider`, `providerInstanceId`,
  `driverKind`) at the top level of `tool_input` and under `target` (T3 Code's shape). A call without
  a model skips the model checks; the speed-mode guard and provider cooldowns still apply.
- No `Stop` hook is installed.
- Legacy PowerShell hooks (`safety-guard.ps1`, `post-format.ps1`, `pre-compact.ps1`,
  `session-start.ps1`): if still wired in `settings.json` from an earlier local setup, remove them so
  both sets do not run; `doctor` warns while they remain wired.

## Security and privacy

- No runtime dependencies. The package's own code makes no network requests and has no telemetry.
- It does run provider CLIs, which may use the network: `check-models`, `sync-models` and
  `init --probe` send live prompts, `check-models` also runs their `--version` and your `discovery`
  commands, and `quota check` runs their login status commands.
- `discovery` commands run with your permissions. Add only commands you trust.
- Provider detection only checks that config folders exist; it opens nothing inside them.
- Probes run in an empty temp directory, and the cooldown reasons they record never quote CLI output.
- Commands are resolved from absolute `PATH` entries, never the current directory.
- Install and uninstall protect your edits and refuse symlinked paths inside the config directory,
  with the exceptions described in [What `init` touches](#what-init-touches).
- Guard hooks have [known limits](#known-limits). Do not rely on them as a security boundary.

Report vulnerabilities as described in [SECURITY.md](https://github.com/mirceas94/t3-auto-build/blob/main/SECURITY.md). To contribute,
see [CONTRIBUTING.md](https://github.com/mirceas94/t3-auto-build/blob/main/CONTRIBUTING.md).

## Troubleshooting & Common Gotchas

- **Informational `doctor` warnings (missing optional provider CLIs):** `doctor` checks `PATH` for
  the CLI binary of every provider whose tier is not `none`, as well as optional tools, and exits
  `0` when only warnings are present (`1` only on failures). Warnings about missing provider CLIs
  you do not invoke locally (for example, `antigravity` or a CLI you only use through T3 Code) are
  informational and do not stop `$auto-build` from running. If you do not use a provider at all,
  set its tier to `none` with `init` to clear the warning.
- **Optional search and formatter tools (`rg`, `sg`, `PostToolUse` formatters):** `rg` (ripgrep)
  and `sg` (ast-grep) are optional—`doctor` warns when they are absent, and install commands are
  below in [Optional tools](#optional-tools). The `post-tool-use.mjs` hook formats edited files
  using `biome`, `prettier`, `ruff`, or `gofmt` when present on `PATH`; if none are installed, it
  silently skips formatting and never blocks edits.
- **Keep repo-specific scripts and Actions in your project, not in `~/.claude/`:** Files under
  `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) are managed by `t3-auto-build` and tracked in
  `t3-auto-build.manifest.json`. Keep project-specific scripts, custom `discovery` adapters, and
  GitHub Actions workflows inside your repositories rather than editing managed `~/.claude/` files;
  hand-edited managed files are skipped with warnings on `init`/`upgrade` (or backed up to `.bak`
  and overwritten when `--force` is used).
- **Keep local runtime state and cache files gitignored:** Per-repo orchestrator state
  (`.claude/auto-build-state.json`, `.claude/repo-profile.md`) and local cache/lock/backup files
  (`auto-build-cooldowns.json`, `auto-build-availability.json`, `*.bak`) are machine-local runtime
  artifacts. Keep them in `.gitignore` so personal cooldowns, availability caches, and in-progress
  wave state are never committed.

## Optional tools

`doctor` warns when these are missing:

| Tool | Windows | macOS | Linux |
|---|---|---|---|
| ripgrep (`rg`) | `winget install BurntSushi.ripgrep.MSVC` | `brew install ripgrep` | `apt install ripgrep` |
| ast-grep (`sg`) | `winget install ast-grep.ast-grep` | `brew install ast-grep` | `npm i -g @ast-grep/cli` |

## Development

```sh
node --test
```

Tests run in temporary directories with `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` overridden.

## License

MIT

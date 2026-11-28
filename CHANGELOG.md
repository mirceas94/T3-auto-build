# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-11-27

Version 3.0.0 cuts the `$auto-build` skill context by over 70%, replaces multi-step startup checks with a single `preflight` command, and adds live quota-aware routing so work automatically avoids low-quota pools. It also introduces schema v3 configs with `catalog.overrides.json`, a local run ledger with `stats`, self-healing `doctor --fix`, and stricter safety guards.

### Highlights

- **70%+ smaller skill context:** Rendered `SKILL.md` shrinks to 5.0–6.0 KiB (~5.2 KB template, down from ~21 KB), loading flag, cooldown, state, and rule references on demand via `t3-auto-build ref`.
- **One-call Step 0 (`preflight`):** `t3-auto-build preflight --json` runs model checks, prunes and rechecks cooldowns, reads live quotas, and returns active locks, resolved ladders, `git status` baseline, and resume state.
- **Live quota-aware routing:** Reads remaining quota from Claude, Codex and Antigravity, sorts eligible ladder entries by remaining pace, auto-locks nearly exhausted pools (and unlocks them when the quota resets early), and handles mid-run quota errors with `quota check --on-error`.
- **Self-healing installs (`doctor --fix`):** Dry-run by default; repairs missing or drifted hooks, manifest hashes, skill mirrors, the runtime snapshot, and the state file's git `info/exclude` entry.
- **Local run ledger and stats:** Record steps with `trace record` and review runs, failovers, and audit rejections with `stats` — kept strictly on your machine.
- **Stricter guards and model overrides:** Hardens secret-file, `rm`, `git`, `delegate_task`, symlink, and payload-size guards, and lets v3 configs retire or alias models via `catalog.overrides.json`.

### Breaking changes and upgrade steps

- **Schema v3 configs:** New subscription installs and `upgrade` write `schemaVersion: 3`. 2.x hooks and CLI do not recognize schema 3 and fall back to default settings — restore the `.bak` config backup before downgrading.
- **Upgrade behavior:** `upgrade` now converts both v1 and v2 configs to v3, backing up files it may change and restoring them if a write fails. It stops before writing if an installed hook has local changes.
- **Upgrading from 2.x:**
  1. Run `npx t3-auto-build@3.0.0 upgrade`. If it stops because an installed hook was edited locally, run `npx t3-auto-build@3.0.0 init --force` (which backs up edits to `.bak`) and re-run `upgrade`.
  2. Restart T3 Code (and any open Claude Code sessions) so updated hooks and `settings.json` load.
  3. Upgrading from 1.x? Run `upgrade` as above, then set your real tiers with `npx t3-auto-build@3.0.0 init --claude-tier <tier> --codex-tier <tier> --antigravity-tier <tier>` and restart T3 Code. See [Upgrading](README.md#upgrading) and [Migrating from v1](README.md#migrating-from-v1).

### Added

- **Preflight and quota routing:**
  - `preflight [--json] [--flags <text>] [--cwd <dir>] [--refresh]`: single deterministic Step 0 call that runs model checks (cooldown pruning and lock rechecks) and reports active locks, resolved ladders, `recheck-via-t3` canaries, `git status` baseline, resume state, `quota`, `expiresAt`, and `configHash`.
  - Quota-paced routing in `preflight`: reads provider quota (capped at 20s; timed-out reads are aborted so no late cache or lock writes happen, falling back to cache marked stale), caches it in `auto-build-quota.json` (no account IDs or emails), and orders eligible ladder entries by pace (scarce pools stay last; unknown pace keeps ladder order).
  - Preflight `warnings`: suggests `--budget` when the parent model's weekly quota is known and under 20% (never changes the parent; `quota.claudeUsage: false` turns Claude quota off).
  - Quota readers: Codex (`codex app-server`, experimental), Antigravity (`agy -p /usage`), and Claude (`claude -p /usage --no-session-persistence --safe-mode`; on by default, saves no session).
  - `quota check [subject] [--refresh] [--on-error] [--claude-usage] [--json]`: reads live quota and writes or lifts threshold locks; `--on-error` waits out a reset under 2 minutes away and answers `retry`, else answers `failover` and burst-locks that pool when no window is exhausted.
- **CLI and diagnostics:**
  - `ref <flags|cooldowns|state|rules|all>`: on-demand reference text rendered from the installed config.
  - `trace record` and `stats [--days <n>] [--json]`: local JSONL run ledger (`auto-build-ledger.jsonl`) with size rotation and a summary report.
  - `doctor --fix [--yes] [--cwd <dir>]`: dry-run by default; repairs missing or drifted hooks and their manifest hashes, skill mirrors, `auto-build-runtime.json`, and the state file's git `info/exclude` entry.
- **Configuration and workflow rules:**
  - `catalog.overrides.json` (v3 configs): retire additional models and alias model names without a package release (`models` entries are validated but not yet applied).
  - Config keys `telemetry`, `preflight`, `catalogOverrides`, and `quota` (`minRemainingPct`, `ttlMs`, `claudeUsage`, `burstLockMs`).
  - Generated `auto-build-runtime.json` snapshot of the allowlist and bans for v3 configs.
  - Skill rules: every handoff packet (builder, tester, auditor, architect) carries the repo profile's test isolation rules; shared contracts land in wave 1 and stay frozen for parallel builders; after fix round 2 only a logged, re-verified orchestrator micro-patch (10 lines or fewer) is allowed; auditors receive blind tests and results, and any auditor's reproduced `BLOCKER` vetoes approval.

### Changed

- **Skill and hooks:**
  - Slimmed `SKILL.md` template to ~5.2 KB (down from ~21 KB) and rendered `SKILL.md` to 5.0–6.0 KiB using `preflight --json`, on-demand `t3-auto-build ref`, and compact numbered allowlist indices.
  - Moved the model catalog and retired list to `hooks/_catalog.mjs`, installed with the hooks.
  - `pre-tool-use.mjs` returns early for unguarded tools (`Read`, `Grep`, `Glob`, etc.) after checking input shape; `pre-compact.mjs` omits empty list lines.
- **Quota and cooldowns:**
  - Quota windows at or below `quota.minRemainingPct` (default `3`) lock the mapped provider or pool until reset without shortening a longer lock.
  - After a mid-run quota error, the skill runs `quota check <provider:model> --on-error` and follows its action (`quota set` remains the manual fallback).
  - Cooldown, availability, and quota lock writes take a file lock and replace files atomically.
  - Dated model bans (e.g. `claude-x-20250101`) block both that ID and its undated name, which also matches other dated releases of that model.
- **Install, config, and maintenance:**
  - Config validation is stricter while still allowing legacy malformed `retiredModels` lists to upgrade.
  - Settings backups use `settings.json.bak`, `.bak.1`, etc., reusing an identical existing backup.
  - Manifest ownership: `init --force` records identical files so `uninstall` removes them; plain `init`, `sync-models`, and `doctor --fix` never claim an unowned identical skill mirror.
  - `uninstall` now also removes `auto-build-quota.json` and `auto-build-runtime.json`.
  - Developer internals and CI: split modules into `lib/install/{plan,write,upgrade}.mjs` and `lib/discover/{sources,merge,cache}.mjs`; CI syntax checks cover `lib/*/*.mjs`; publish workflow fails unless `HEAD` is the `v<version>` tag commit.

### Fixed

- Legacy `tier:<provider>:heavy` cooldowns now also lock the catalog's scarce models for that provider, unless the config lists its own `heavyModels`.
- `sync-models --force` now forwards `--force` to config sync so an edited managed `SKILL.md` is backed up and replaced.
- The `git push` guard no longer blocks a branch name such as `bug-fix`; force flags stay blocked.
- The Antigravity CLI is now found as `agy` (then `antigravity`), so `doctor` no longer reports it missing, model checks record its version, and `init` can suggest `tri-provider`.

### Security

- **PreToolUse guards:**
  - Strips NTFS alternate data stream suffixes (`:stream`, `::$DATA`) from `Edit`/`Write`/`MultiEdit` paths before the secret-file check.
  - Blocks brace-list and bare whole-variable `rm` targets.
  - Detects force pushes, `+ref` pushes, and `git reset --hard` even after git global options (`-C`, `-c`, `--git-dir`, etc.).
  - Blocks non-object `delegate_task` `target` values and validates the `model` option.
- **Hook input limits:** Caps hook stdin at 8 MiB; `pre-tool-use.mjs` blocks oversized payloads while other hooks fail open.
- **Symlink and ledger safety:**
  - Skips symlinked `.bak` backups, refuses a symlinked manifest, and makes `quota clear --all` refuse a symlinked or non-regular cooldown file.
  - Keeps `auto-build-ledger.jsonl` local-only with a fixed set of short single-line fields, refuses symlinked ledger paths, and supports `telemetry.enabled: false`.
- **Catalog override safety:** `catalog.overrides.json` cannot un-retire built-in retired models or alias retired models, cross-provider targets, or two built-in models; invalid files are ignored except for a well-formed `retiredModels` list.

### Docs

- Restructured [README.md](README.md) with a plain-language User Guide at the top and an [Advanced reference](README.md#advanced-reference) section below.
- Aligned `CONTRIBUTING.md`, `SECURITY.md`, and `.github/` workflows and issue templates with 3.0.0 (test isolation, sanitize checks, project structure, and release workflows).

## [2.3.0] - 2026-11-27

### Added

- Skill template (`skills/auto-build/SKILL.md.tmpl`): builder rules (reuse existing code and the standard library, no speculative abstractions, list assumptions), terse sub-agent replies, a `Not checked:` line in the final report, and optional Context7 verification of third-party library APIs.
- Core rules (`core/CLAUDE.md`): state assumptions and tradeoffs, reuse before adding code, simplest design.
- Installed version: `init` and `upgrade` record the package version in the manifest, and `doctor` prints it (warning when it differs from the running CLI).
- Catalog & tiers (`lib/plans.mjs`): added `gpt-6.2-sol` (standard) and `gpt-6.2-astra` (scarce `astra` pool) to paid Codex tiers (`plus`, `pro-100`, `pro-200`, `pro-500`, `business`, `api`), and added `claude-fable-5-2` (scarce `fable` pool + `--parent fable`) to Claude `max`.
- Documentation (`README.md`): Context7 note under Optional tools; how to update an existing install; how to adopt newly released models; grouped Table of Contents; CLI examples and tier tables updated for `2.3.0`.
- GitHub workflows & templates (`.github/`): hardened `publish.yml` OIDC `id-token: write` scope, release-tag verification, and `package-manager-cache: false`; added tailored issue templates for model/tier updates, hook guard false positives, and documentation improvements.

## [2.2.0] - 2026-11-27

### Added

- Multi-provider `SKILL.md` mirroring (`lib/mirrors.mjs`): `init`, `upgrade`, and `sync-models` now mirror the rendered `auto-build/SKILL.md` into existing provider skill directories (`~/.codex/skills`, `~/.agents/skills`, `~/.gemini/config/skills`, and T3 Code Antigravity `config/skills` profiles, resolving Antigravity junctions inside `$HOME`) by default (`--skill-targets auto`), with `--skill-targets none` and `--skill-targets <dir1>,<dir2>` overrides.
- Manifest, `doctor`, and `uninstall` mirror lifecycle (`lib/manifest.mjs`, `lib/install.mjs`, `lib/doctor.mjs`): tracked `skillMirrors` hashes, symlink safety via `safePath`, user-edit preservation (`.bak` backups on `--force`), `--modules core` and `uninstall` cleanup, and `doctor` verification.

### Changed

- Skill template (`skills/auto-build/SKILL.md.tmpl`): explicitly requires delegating Triage, Builder, and `L1`–`L3` Cross-Provider Audit and emitting the Step 7 Model Trace whenever `delegate_task` is available (directly or via T3's ACP fallback).
- Documentation (`README.md`): updated CLI examples to `2.2.0`, fixed clipped `Step 0` Mermaid labels and `L0` vs `L1`–`L3` audit/blind-test flow, documented `--skill-targets` and Claude-only `settings.json` hook scope, fixed `quota clear` synopsis and misplaced `availability mark` snippet, and removed leftover internal hook notes.

## [2.1.2] - 2026-11-26

### Changed

- Documentation (`README.md`): added a Table of Contents, split multi-command Quick Start and model-drift snippets into dedicated copy-pasteable blocks, compacted the Mermaid workflow diagram labels to avoid clipping, and broke dense `sync-models`, workflow, and cooldown prose into scannable bullets.

## [2.1.1] - 2026-11-26

### Changed

- Documentation (`README.md`): aligned onboarding, `12h` availability cache and safe-by-default model drift (`--apply --dry-run`), `sync-models` v2 candidate/probe behavior, `gpt-6.1-terra`/`gpt-6.1-sol` starting models, custom-instance cooldown isolation, and `Troubleshooting & Common Gotchas` with `2.1.0`.

## [2.1.0] - 2026-11-26

### Fixed

- Quota and cooldown lock matching (`hooks/_quota.mjs`): normalized `tier:` provider alias lookups (`config.tiers`, `HEAVY_MODELS`, `SCARCE_POOL`), gated legacy heavy-model matching on provider match to prevent cross-host leaks, and isolated custom instance keys (`tier:codex-2:*`, `model:codex-2:*`) from canonical providers.
- Rate-limit clock parsing (`hooks/_quota.mjs`): `parseRateLimit()` now honors explicit `UTC`/`GMT`/`Z` clock times via UTC date methods and only enters the `5h` branch when `clockIn()` parses a valid time.
- Quota CLI (`lib/quota.mjs`): `quotaSet()` now uses `host` for `config.tiers` lookup (supporting custom `modelIds`) and falls back to `'heavy'` when `SCARCE_POOL[host]` is absent; `countdown()` returns `'unknown'` for non-finite values and `'0s'` for non-positive durations; `quotaClear()` fixes malformed stub scope for qualified models, matches `tier:` provider aliases via `exactProvider`, and handles display-name/cased qualified model keys.
- Probe cooldowns (`lib/probe.mjs`): `syncModels()` now forwards `{ now }` to `writeCooldowns()`, preserves the longest `until` per cooldown key across probe results in the same run, and exits with code `2` on unknown providers.
- Availability & restrictions (`hooks/_shared.mjs`, `lib/discover.mjs`, `bin/cli.mjs`): aligned staleness boundary to strict `<` with `ttlMs > 0` fallback, preserved live manual marks without a parseable `until` in `put()`, shared normalized `isPlanRestricted()`, and added optional `config` forwarding to `restrictedBy()` for `modelIds` aliases.
- Doctor & install hardening (`lib/doctor.mjs`, `lib/install.mjs`): `doctor` skips `tierId === 'none'` warnings, guards `NaN` availability age, validates `isFile()` / `fileHash()` safely inside `attempt()`, checks `isObject()` for cooldown JSON, and guards `CONFIG_FILE`, `AVAILABILITY_FILE`, and `COOLDOWN_FILE` with `safePath()`; `completeConfig()` no longer masks `ladders: null` before validation.
- CLI & hook guards (`bin/cli.mjs`, `hooks/pre-compact.mjs`, `hooks/pre-tool-use.mjs`): `sync-models --apply --dry-run` no longer writes config or `SKILL.md`; `pre-compact.mjs` renders availability marks whose model names contain spaces or instance hyphens while rejecting control characters; `pre-tool-use.mjs` enforces per-provider allowlist membership (blocking bare `claude-*` calls when native Claude has no allowlisted models).
- Test suite: fixed false-positive cooldown test in `test/v2-edge.test.mjs` and expanded regression coverage to 224 passing tests.

## [2.0.2] - 2026-11-26

### Changed

- Document starting-model orchestrator behavior, task-based starting-model recommendations,
  hook guard scope, and same-thread follow-up rules in README and the skill template.
## [2.0.1] - 2026-11-26

### Added

- `check-models` prints one `provider:model status` line per configured model.
- Lock rechecks: locks longer than 6 hours carry `setAt` and `recheckAfter`. Due provider locks are
  probed (Claude, Codex) or reported as `recheck-via-t3` for a canary delegation. New
  `check-models --recheck-locks`.

### Changed

- Codex `free` and `go` are CLI tiers with `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna`, one
  parallel builder and no warning.

### Fixed

- `quota clear` accepts `provider:<provider>`.

## [2.0.0] - 2026-11-26

### Added

- Subscription profiles: `init --claude-tier`, `--codex-tier`, `--antigravity-tier`, `--parent`,
  `--allow-usage-credits`, `--allow-fast-modes` and `--verified-org`.
- Parent-model routing: `init` writes `model` and `effortLevel` to `settings.json` when they are
  absent or still hold the value it wrote.
- Cross-hosted overflow: `claude-sonnet-5-5` and `claude-opus-5-5` on Antigravity `pro`, `ultra-5x`
  and `ultra-20x`, in the scarce `third-party-claude` pool.
- `upgrade`, `check-models`, `availability mark`, `availability status`, `quota set --pool`, and the
  `sync-models` flags `--apply`, `--auto`, `--refresh` and `--probe-scarce`.
- Availability cache `auto-build-availability.json` with a 12-hour probe TTL, manual marks and model
  drift detection through `discovery` adapters.
- Speed-mode guard, controlled by `allowFastModes`.
- `doctor` checks for the v2 schema, availability cache, tier binaries and drift.

### Changed

- **BREAKING:** subscription installs write config `schemaVersion: 2`. An unknown `schemaVersion`
  makes the hooks fall back to default settings.
- **BREAKING:** the default roster is `gpt-6-luna`, `gpt-6.1-terra` and `gpt-6.1-sol` on Codex,
  replacing the `gpt-5.6-*` models.
- **BREAKING:** `pre-tool-use` blocks provider/model conflicts (such as a Claude model on a provider
  that does not host it) and parsed payloads whose `tool_input` is not an object.
- **BREAKING:** pool locks use `tier:<provider>:<pool>` keys, and a lock may name one hosting
  (`model:<provider>:<id>`). Legacy `tier:<provider>:heavy` keys are still read.
- `sync-models` and probes skip scarce-pool models unless `--probe-scarce` is set.
- `session-start` and `pre-compact` report restrictions and availability.
- The `auto-build` skill checks availability on every run and respects the parallel-builder limit.
- `--tiers` records the scarce models as the heavy models.
- `uninstall` also removes the availability cache.
- CI uses `actions/checkout` 7.0.1 and `actions/setup-node` 7.1.0.

### Removed

- Preset bans on `Argon` and `Fable/Mythos`. The built-in retired list blocks `gemini-4-argon`; Fable
  is now a scarce pool on Claude `ultra` and `api`.

### Security

- A built-in retired-model list is always enforced. Configuration can extend it, not shrink it.
- Plan-restricted and unavailable models are blocked at delegation time.

### Migration

1. Run `t3-auto-build upgrade`. It backs up the config to `.bak`, moves your own bans to
   `userBannedModels` and writes a v2 config.
2. Tiers are assumed (Claude `pro`, Codex `plus`, Antigravity `plus`). Set yours with
   `t3-auto-build init --claude-tier <tier> --codex-tier <tier> --antigravity-tier <tier>`.
3. Re-apply custom allowlist entries and `defaultModel`; they are not carried over. Neither is
   `planRestricted`.
4. Restart T3 Code.

See [Migrating from v1](README.md#migrating-from-v1).

## [1.0.1] - 2026-11-26

### Added

- `--version` / `-v`.
- Logo and banner, CI workflow, Dependabot, issue and pull request templates, `SECURITY.md` and
  `CONTRIBUTING.md`.

### Changed

- Rewrote the README and completed the package metadata.

### Fixed

- A pre-compact test now builds its state path portably on POSIX.

## [1.0.0] - 2026-11-26

### Added

- Zero-dependency `t3-auto-build` CLI: `init`, `doctor`, `uninstall`, `sync-models` and `quota`.
- The `auto-build` skill, core `CLAUDE.md`, rules and commands, and presets `tri-provider`,
  `claude-codex` and `claude-only`.
- Guard, session, compaction and formatting hooks.
- Provider detection, cooldown tracking and model probing.

### Security

- Hardened the recursive `rm` guard, cooldown handling, the pre-compact state boundary and
  `sync-models --force`.

[3.0.0]: https://github.com/mirceas94/T3-auto-build/compare/v2.3.0...v3.0.0
[2.3.0]: https://github.com/mirceas94/T3-auto-build/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/mirceas94/T3-auto-build/compare/v2.1.2...v2.2.0
[2.1.2]: https://github.com/mirceas94/T3-auto-build/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/mirceas94/T3-auto-build/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/mirceas94/T3-auto-build/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/mirceas94/T3-auto-build/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/mirceas94/T3-auto-build/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mirceas94/T3-auto-build/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/mirceas94/T3-auto-build/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mirceas94/T3-auto-build/releases/tag/v1.0.0

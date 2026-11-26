# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.0.1]: https://github.com/mirceas94/t3-auto-build/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mirceas94/t3-auto-build/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/mirceas94/t3-auto-build/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mirceas94/t3-auto-build/releases/tag/v1.0.0

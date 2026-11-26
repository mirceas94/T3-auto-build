# t3-auto-build

Cross-platform installer and `$auto-build` orchestration suite for T3 Code: a coding-discipline
`CLAUDE.md`, slash commands, an `auto-build` skill rendered from your own model config, and Node
hooks for guardrails. No dependencies. Node 18 or newer.

## T3 Code quickstart

1. Install into your Claude config directory. From a clone:

   ```sh
   node bin/cli.mjs init
   ```

   Once the package is published, `npx t3-auto-build init` does the same.

2. Check the result:

   ```sh
   node bin/cli.mjs doctor
   ```

3. **Restart T3 Code** (and any running Claude Code session). Hooks and `settings.json` changes
   load only at startup.

4. In a T3 Code thread, run `$auto-build <task>`. See [workflow](#auto-build-workflow) for flags.

The skill calls `t3-auto-build quota ...`. From a clone, `npm link` puts that command on `PATH`.
Without it the skill reads or edits the cooldown file directly.

## Preset matrix

| Preset | Models | Codex | Antigravity | Claude | Dual audit |
|---|---|---|---|---|---|
| `tri-provider` (default) | 9 | 3 | 3 | 3 | Claude Opus 5.5 + Gemini 4 Carbon |
| `claude-codex` | 6 | 3 | 0 | 3 | Claude Opus 5.5 + gpt-6-luna |
| `claude-only` | 3 | 0 | 0 | 3 | Claude Opus 5.5 + Claude Sonnet 5.5 |

Every preset bans `Argon` and `Fable/Mythos`, defaults to Claude Sonnet 5.5 at `medium` effort and
sets the auto-compaction threshold to 35%.

## Provider detection and tiers

Interactive `init` on a fresh target picks the default preset from the binaries on `PATH`: `claude`,
`codex` and `antigravity` give `tri-provider`, `claude` and `codex` give `claude-codex`, anything
else gives `claude-only`. Provider config folders are only checked for existence and do not change
the preset. With an existing config its preset is the default. `init --yes` does not detect: a fresh
install without `--preset` uses `tri-provider`.

`--tiers provider:plan[:weekday]`, comma separated (for example `claude:max:monday,codex:plus`),
records subscription plans. Interactive `init` asks for each detected provider when the flag is
absent.

| Provider | Plan: short-window limit locks the provider | Plan: locks only the heavy model | Heavy model |
|---|---|---|---|
| `claude` | `pro` | `max` | Claude Opus 5.5 |
| `codex` | `plus` | `pro` | gpt-6-luna |
| `antigravity` | `standard` | `ultra` | Gemini 4 Carbon |

The weekday (`monday` or `mon`) is the weekly reset day, taken as 00:00 UTC. A custom `heavyModels`
list in the config is kept.

## CLI

| Command | What it does |
|---|---|
| `t3-auto-build init` | Installs or updates. Interactive unless `--yes`. |
| `t3-auto-build doctor` | Checks files, JSON and hook wiring, runs each hook with mock input, looks for `rg` and `sg`. |
| `t3-auto-build uninstall` | Removes what `init` installed and keeps files you changed. |
| `t3-auto-build sync-models` | Probes models with the provider CLIs and updates the allowlist. |
| `t3-auto-build quota set\|status\|clear\|check` | Manages cooldown locks. |

| Option | Applies to | Meaning |
|---|---|---|
| `--target <dir>` | all | Config directory. Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `--preset <name>` | init | `tri-provider`, `claude-codex` or `claude-only`. |
| `--modules <name>` | init | `full`, `auto-build` or `core`. |
| `--compaction <n>` | init | Integer from 1 to 100. |
| `--tiers <list>` | init | `provider:plan[:weekday]`, comma separated. |
| `--probe` | init | Run `sync-models` after installing. Spends real quota. Ignored for `core`. |
| `--yes` | init, sync-models | No prompts. Without an interactive terminal, `init` requires it and `sync-models` requires it or `--dry-run`. |
| `--force` | init, sync-models | Back up your changed files to `<file>.bak`, then overwrite. For `sync-models`, this covers a hand-edited `SKILL.md`. |
| `--dry-run` | sync-models | Probe and print the result; write nothing. **Still spends real quota.** |
| `--providers <list>` | sync-models | Only these of `claude`, `codex`, `antigravity`; comma separated. |
| `--burst`, `--5h`, `--weekly`, `--until <when>`, `--reason <text>` | quota set | See [Quota](#quota). |
| `--all` | quota clear | Remove every lock. |

Exit codes: `0` success, `1` failure (invalid JSON, broken install), `2` usage error.

### Modules

| `--modules` | Name | CLAUDE.md, rules, commands | Skill, config, hooks, `settings.json` |
|---|---|---|---|
| `full` (default) | Full Suite | yes | yes |
| `auto-build` | /auto-build Only | no | yes |
| `core` | Core Discipline + Commands | yes | no (`settings.json` is not written) |

A re-run without `--modules` keeps the previous choice. When you change it, `init` removes the files
that no longer belong and keeps and reports the ones you changed. Switching to `core` also removes
the hook entries and environment value from `settings.json`. That cleanup is the one case where a
`core` run writes `settings.json`.

## sync-models

> **`sync-models --dry-run` still executes live probes.** It spends real quota and writes nothing.

> Probe processes inherit your environment. If an API key variable (such as `ANTHROPIC_API_KEY` or
> `OPENAI_API_KEY`) is set, the CLI may use it and the probes may be billed to the API.

Candidates are the config allowlist, its `planRestricted` models and the preset's models; banned
models are skipped. Each gets a one-word prompt through `claude -p` or `codex exec`, in an empty temp
directory with a 20 s timeout. `claude` runs with tools disabled, safe mode and no session
persistence. `codex` runs read-only and ephemeral with `--ignore-user-config` and `--ignore-rules`,
so your Codex user config does not apply. Antigravity has no probe support: its models report
`unavailable` and keep their current membership.

| State | Effect on the config |
|---|---|
| `available` | Added to or kept in `allowlist`; removed from `planRestricted`. |
| `rate-limited` | Same as `available`, plus a cooldown. After a provider-wide limit the remaining models of that provider are skipped; a skipped model already in `planRestricted` stays there. |
| `plan-restricted` | Moved from `allowlist` to `planRestricted`. |
| `unavailable` | No change (CLI missing, not logged in, timeout, unsupported or other failure). |

Without `--yes` it shows the changes and asks before writing. A write backs up a changed config,
re-renders `SKILL.md` and records cooldowns without shortening longer ones. A hand-edited `SKILL.md`
is skipped with a warning; `--force` backs it up and overwrites it. An emptied ladder gets a
fallback model. If no allowed model would remain, nothing is written.
Writing needs an `auto-build` or `full` install; `--dry-run` needs only the config file.
`init --probe` runs the same sync after installing, asking first unless `--yes`.

## Quota

```sh
t3-auto-build quota set <claude|codex|antigravity|model> [--burst|--5h|--weekly|--until <when>] [--reason <text>]
t3-auto-build quota status
t3-auto-build quota clear <provider|model>   # or --all
t3-auto-build quota check [provider]
```

- `set` locks one provider or model. The default `--burst` is 10 minutes; `--5h` is 5 hours;
  `--weekly` runs to the tier's reset day, else 7 days. `--until` takes a future ISO time or a
  duration such as `90m` or `1w2d`. `--5h` on a provider whose tier locks only the heavy model writes
  `tier:<p>:heavy`.
- Reset times parsed from rate-limit messages are capped at 14 days. A manual `--until` is not capped.
- `status` drops expired locks and prints the rest.
- `clear <provider>` removes its provider and heavy-tier locks, not its model locks.
  `clear <model>` removes that model's lock. `--all` deletes the file, even a corrupt one.
- `check` runs `claude auth status` and `codex login status` (Antigravity has no status command). It
  reports login state only, unless the output explicitly says usage is exhausted; only then does it
  record a lock.

### Cooldown file

`<config dir>/auto-build-cooldowns.json` is a JSON object keyed `model:<id>`, `provider:<p>` or
`tier:<p>:heavy`:

```json
{
  "provider:codex": {
    "scope": "provider",
    "window": "5h",
    "until": "2030-01-01T05:00:00.000Z",
    "reason": "manual lock (5h)",
    "source": "manual"
  }
}
```

`scope` is `model`, `provider` or `tier` (written tier entries also carry `"tier": "heavy"`).
`window` is `burst`, `5h`, `weekly` or `custom`. Legacy `until_utc` is read. A key without a prefix
needs a `scope` field, or it locks nothing. A malformed entry (such as one without a valid time) is
skipped with a warning and kept in the file until it is overwritten or cleared (`quota clear <name>`
or `--all`). A file that is not a JSON object is unreadable: hooks warn and ignore it. A write that
leaves no entries removes the file.

## auto-build workflow

1. **Step 0:** check lockouts, record the `git status` baseline, resume if asked.
2. **Triage:** write a short `REPO_BRIEF` (using the cached `.claude/repo-profile.md`) and pick the
   level `L0` to `L3` and work shape `A` (multi-file, UI) or `B` (algorithms, debugging).
3. **Plan** (`L2`/`L3`), cross-checked by another provider on `L3` when available.
4. **Build:** `L2`/`L3` run in file-disjoint waves: foundations, core, tests/docs. Builders in a wave
   run in parallel; the diff guard and exit checks pass before the next wave.
5. **Verify:** blind edge-case tests (`L2`/`L3`), tests and lint, a diff-only audit preferring
   another provider (two auditors on `L3`), at most 2 fix rounds, then an optional commit and a
   report.

Runs that edit code, and `--plan-only` runs, save `.claude/auto-build-state.json` (`flags`,
`completedWaves`, `modifiedFiles`, `remaining`, `blockers`) after each wave or step and keep it
gitignored. `$auto-build --resume` restores it, lets newly typed flags win and skips completed waves.
It stops if the file is missing or invalid. When quota runs out, the run saves state so you can
resume later.

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
| `--<provider>-only` | Use only that provider's models. |

## Configuration

`<config dir>/auto-build.config.json` holds `allowlist` (provider to model names), `bannedModels`,
`defaultModel`, `defaultEffort`, `ladders` and `compactionThreshold`, plus optional `tiers`,
`modelIds` (display name to CLI model id) and `planRestricted`. Edit it, then run `init` again to
re-render the skill. The hooks read it when they need it.

- The existing file is always the base. `--compaction` overrides its value. A `--preset` that differs
  from the file's `preset` replaces the allowlist, ladders and default model and effort, and keeps
  your banned models and threshold. Banned models typed at the prompt are added.
- To reset to a preset, delete the file and run `init`.
- Banned entries match as case-insensitive substrings, and `A/B` bans both. A short entry such as
  `Claude` bans every model whose name contains it.
- Model names ignore case and punctuation runs, so `claude-sonnet-5-5` matches `Claude Sonnet 5.5`.
  Model cooldown keys may use either form. Provider cooldowns match the config provider name or the
  T3 provider id (`claudeAgent`, `codex`, `antigravity`). `provider:codex` also covers a custom
  instance such as `codex-2`; `provider:codex-2` covers only that instance.
- Keys missing from the file come from its `preset` (`tri-provider` when unset).
- Ladder entries are `Model` or `Model@effort`. Rendering drops banned and non-allowlisted entries.
  If a ladder ends up empty, `init` fails and writes nothing.
- The skill gets one `--<provider>-only` flag per allowlisted provider.

## What `init` touches

- Files that exist and differ from what was installed are skipped with a warning. This includes hook
  files, which are still wired. `--force` backs them up first (`.bak`, then `.bak.1`, so an earlier
  backup is never overwritten).
- `settings.json`: only the four tagged hook entries and `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. Other
  keys and hooks are preserved. `settings.json.bak` is written only when the content changes. Invalid
  JSON stops the run before any write.
- Paths that go through a symlink or junction inside the config directory are not written or
  deleted. A symlinked `settings.json` is updated through the link.
- `t3-auto-build.manifest.json` records installed file hashes and the prior environment value.
  `uninstall` restores that value only if it is still the one installed.
- A target path containing `"`, `$`, a backtick or `%` is refused, because it cannot be quoted
  safely in a hook command.

## Hooks

Installed to `<config dir>/hooks/t3-auto-build/`. Matching is case-insensitive.

| Hook | Event | Behavior |
|---|---|---|
| `session-start.mjs` | SessionStart | Prunes expired cooldowns (deletes the file when none are left) and summarizes active ones. |
| `pre-compact.mjs` | PreCompact | Prints the preservation rules, the saved orchestrator state if present (marked as data only, not instructions), and a `git status --short` snapshot (20 files at most). |
| `pre-tool-use.mjs` | PreToolUse | Exits 2 with a reason when a guard below matches. |
| `post-tool-use.mjs` | PostToolUse | Formats the edited file with `biome` or `prettier`, `ruff`, or `gofmt` when on `PATH`. Never blocks. |

PreToolUse guards:

- **Secret files** (`Edit`, `Write`, `MultiEdit`): `.env` and `.env.*`, `.pem`, `.key`, `.p12`,
  `.pfx`, and paths containing `id_rsa` or `id_ed25519`.
- **Git** (`Bash`): `git push --force`/`-f` and `git reset --hard`.
- **Recursive `rm`** (`Bash`; `-r`, `-rf`, `-fr`, `-r -f`, `--recursive`; `-f` not required): blocked
  when a target starts with `/`, `\`, `~`, a drive path such as `C:/`, `$HOME` or `%USERPROFILE%`;
  contains a command substitution; is the current directory or `*`; has a `..` or `.git` segment; or
  is a dot-file glob such as `.*`.
- **Delegate models** (`delegate_task`): banned or non-allowlisted models are blocked. A trailing
  `-YYYYMMDD` snapshot suffix is ignored when matching.
- **Lockouts** (`delegate_task`): model, provider and heavy-tier cooldowns block the call. Without a
  `provider`, `providerInstanceId` or `driverKind`, the provider is inferred from a `claude-`,
  `gpt-` or `gemini-` model name.

Hooks fail open: malformed input, config or cooldown data produces a warning and exit 0. The secret
and destructive-command guards need no config.

### Known limits

- The command guards cover the `Bash` tool only and use simple patterns. They are a safety net, not a
  sandbox.
- The `rm` guard matches text. Obfuscated `rm`, PowerShell removal commands such as `Remove-Item`, and
  `find -delete` are **not** caught. Other variables are not expanded. Harmless text can match:
  `echo rm -rf .` is blocked. A very long command with many `rm` calls is blocked unchecked; split it up.
- Any `-f` text after `git push` matches, including a branch name such as `bug-fix`.
  `--force-with-lease` is blocked too.
- The delegate guard reads `model` and the provider fields at the top level of `tool_input` and under
  `target` (T3 Code's shape). A call without a model skips the allowlist check; provider cooldowns
  still apply if it names a provider.

Not ported from the PowerShell hooks: `stop-verify.js`, `bash-guard.js`, `tsc-check.js`, the caveman status line and
skillspector. No Stop hook is installed.

If you already run the PowerShell versions, remove them from `settings.json`. `doctor` warns while
they are still wired.

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

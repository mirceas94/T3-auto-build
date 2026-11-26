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

4. In a T3 Code thread, run `$auto-build <task>`. Add flags such as `--plan-only`, `--dry-run`,
   `--strict`, `--budget` or `--commit`.

## Preset matrix

| Preset | Models | Codex | Antigravity | Claude | Dual audit |
|---|---|---|---|---|---|
| `tri-provider` (default) | 9 | 3 | 3 | 3 | Claude Opus 5.5 + Gemini 4 Carbon |
| `claude-codex` | 6 | 3 | 0 | 3 | Claude Opus 5.5 + gpt-6-luna |
| `claude-only` | 3 | 0 | 0 | 3 | Claude Opus 5.5 + Claude Sonnet 5.5 |

Every preset bans `Argon` and `Fable/Mythos`, defaults to Claude Sonnet 5.5 at `medium` effort and
sets the auto-compaction threshold to 35%.

## CLI

| Command | What it does |
|---|---|
| `t3-auto-build init` | Installs or updates. Interactive unless `--yes`. |
| `t3-auto-build doctor` | Checks files, JSON and hook wiring, runs each hook with mock input, looks for `rg` and `sg`. |
| `t3-auto-build uninstall` | Removes what `init` installed and keeps files you changed. |

| Option | Applies to | Meaning |
|---|---|---|
| `--target <dir>` | all | Config directory. Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `--preset <name>` | init | `tri-provider`, `claude-codex` or `claude-only`. |
| `--modules <name>` | init | `full`, `auto-build` or `core`. |
| `--compaction <n>` | init | Integer from 1 to 100. |
| `--yes` | init | No prompts. Required without an interactive terminal. |
| `--force` | init | Back up your changed files to `<file>.bak`, then overwrite. |

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

## Configuration

`<config dir>/auto-build.config.json` holds `allowlist` (provider to model names), `bannedModels`,
`defaultModel`, `defaultEffort`, `ladders` and `compactionThreshold`. Edit it, then run `init` again
to re-render the skill. The hooks read it on every run.

- The existing file is always the base. `--compaction` overrides its value. A `--preset` that differs
  from the file's `preset` replaces the allowlist, ladders and default model and effort, and keeps
  your banned models and threshold. Banned models typed at the prompt are added.
- To reset to a preset, delete the file and run `init`.
- Banned entries match as case-insensitive substrings, and `A/B` bans both. A short entry such as
  `Claude` bans every model whose name contains it.
- Model names ignore case and punctuation runs, so `claude-sonnet-5-5` matches `Claude Sonnet 5.5`.
  Model cooldown keys may use either form. Provider cooldowns match the config provider name or the
  T3 provider id (`claudeAgent`, `codex`, `antigravity`, or a custom instance such as `codex-2`).
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
| `session-start.mjs` | SessionStart | Prunes expired cooldowns (deletes the file when none are left) and lists active ones. |
| `pre-compact.mjs` | PreCompact | Prints the preservation rules and a `git status --short` snapshot (20 lines at most). |
| `pre-tool-use.mjs` | PreToolUse | Exit 2 with a reason on secret-file edits (`.env`, `.pem`, `.key`, `.p12`, `.pfx`, SSH keys), `git push --force`/`-f`, `git reset --hard`, `rm -rf` on paths starting with `/ \ ~ .`, and banned, non-allowlisted or cooling-down delegate models. |
| `post-tool-use.mjs` | PostToolUse | Formats the edited file with `biome` or `prettier`, `ruff`, or `gofmt` when on `PATH`. Never blocks. |

Hooks fail open: malformed input, config or cooldown data produces a warning and exit 0. The secret
and destructive-command guards need no config.

### Known limits

These come from the PowerShell hooks this project ports.

- The delegate guard checks `model` both at the top level of `tool_input` and under `target` (T3
  Code's shape). A `delegate_task` call without a model is allowed, as in the PowerShell script; only
  provider cooldowns apply to it.
- The command guard covers the `Bash` tool only and uses simple patterns: `-f` anywhere after
  `git push` matches, and `rm -r -f` does not. It is a safety net, not a sandbox.

Not ported: `stop-verify.js`, `bash-guard.js`, `tsc-check.js`, the caveman status line and
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

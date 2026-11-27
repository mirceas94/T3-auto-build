# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 3.x | Yes |
| 2.x | Yes |
| 1.x and older | No, including security fixes. Upgrade, then run `t3-auto-build upgrade` |

## Reporting a vulnerability

Report privately, and only through
[GitHub security advisories](https://github.com/mirceas94/T3-auto-build/security/advisories/new).
Do not open a public issue or pull request for a vulnerability.

Include the version, operating system, Node version and steps to reproduce. Remove tokens, keys and
personal paths first.

## Threat model

The `PreToolUse` hook is a safety net against common mistakes by a coding agent. It is **not a
sandbox** and does not stop a deliberate attempt to get around it. Run untrusted work in an isolated
environment with limited permissions.

The guards apply only when the hooks are installed and wired into `settings.json` (the `full` and
`auto-build` modules).

### What the guards block

| Guard | Tools | Blocked |
|---|---|---|
| Secret files | `Edit`, `Write`, `MultiEdit` | A `file_path` for `.env` or `.env.*`, ending in `.pem`, `.key`, `.p12` or `.pfx`, or containing `id_rsa` or `id_ed25519` |
| Git | `Bash` | Text matching `git push` followed by `-f` or `--force`, or `git reset --hard` |
| Recursive `rm` | `Bash` | A recursive `rm` aimed at an absolute, drive or home path, a command substitution, the current directory, `*`, a `..` or `.git` segment, or a dot-file glob. A command too costly to scan is also blocked |
| Speed modes | `delegate_task` | A fast or priority mode, unless the config sets `allowFastModes` |
| Provider conflicts | `delegate_task` | Two different known providers, or a model on a provider that does not host it |
| Retired models | `delegate_task` | A retired model, whatever the config allows |
| Delegate models | `delegate_task` | A banned or non-allowlisted model |
| Plan and availability | `delegate_task` | A model the config lists as plan-restricted, or an unexpired `plan-restricted` or `unavailable` availability entry |
| Cooldowns | `delegate_task` | A model, provider or model pool with an active cooldown |
| Input shape | Any hooked tool | Parsed input that names a tool but whose `tool_input` is present and not an object |

The model and provider fields (`model`; `provider`, `providerInstanceId`, `driverKind`) are read from the
top level of the tool input and from `target`.

### Speed-mode guard

The hook scans the whole `delegate_task` input, up to 6 levels deep, including `{ id, value }` option
pairs. It blocks a key containing `fast`, `speed` or `serviceTier` (case and punctuation ignored) whose
value is `true`, `fast`, `ultrafast` or `priority`. Only `allowFastModes: true` in a v2 or v3 config turns it
off. It applies even when the call names no model.

### Provider resolution and cooldowns

- With no known provider named, a model resolves to its native provider (`claude-*` to Claude, `gpt-*`
  to Codex, `gemini-*` to Antigravity). An unknown provider alias does not change that, so it cannot
  bypass a `provider:claude` lock.
- A model is cross-hosted only when the call names the hosting provider explicitly **and** the config's
  `models` list declares that model on it. Naming a provider that does not host the model is blocked.
- A `provider:claude` lock does not cover a declared Antigravity-hosted Claude model, which spends
  Antigravity quota. Lock it with `provider:antigravity`, `tier:antigravity:third-party-claude` or a
  model key.

### Retired models

Retired models are a hard ban built into the hooks (`RETIRED_MODELS` in `hooks/_catalog.mjs`). A config
or `catalog.overrides.json` can add to the list but cannot shrink it, and allowlisting a retired model
does not enable it.

### Catalog overrides

`<config dir>/catalog.overrides.json` is read for `schemaVersion: 3` configs unless the config sets
`"catalogOverrides": false`. Only `models`, `retiredModels` and `aliases` are accepted. The invariants:

- It cannot un-retire a built-in retired model. Its `retiredModels` only add bans.
- An alias cannot spoof model or provider identity: it cannot link names of two providers or two
  built-in models. It also cannot involve a retired model or form a cycle.
- A `models` entry for a retired model is rejected. One that puts a model on a provider other than its
  native one needs an explicit `"crossHosted": true`. Valid `models` entries are not yet applied.
- An alias never replaces a `modelIds` entry already in the config.
- Any validation error drops the whole file except a well-formed `retiredModels` list, with a warning.

### Fail-open behavior

- Empty or unparsable hook input, and unexpected errors inside the hook, allow the tool call.
- Input that parses but has an invalid shape (see "Input shape" above) is blocked.
- A missing or malformed availability file restricts nothing.
- An unreadable or non-JSON `catalog.overrides.json` is ignored with a warning, including the models it
  retires. The built-in retired list still applies.
- The `preflight` command does not fail open on locks: it stops on an unreadable cooldown file.
- An unreadable cooldown file, or an invalid cooldown entry, is ignored with a warning. Other valid
  entries still apply.
- An invalid or unreadable config does **not** disable the allowlist or the built-in retired-model ban:
  an invalid setting falls back to its default, and an unreadable file or an unknown `schemaVersion`
  falls back to the default config. Your own bans and plan restrictions in the discarded settings are
  **not** applied until you fix the file.
- A `delegate_task` call without a model skips every model check (conflict, retired, banned, plan,
  availability and allowlist). The speed-mode guard still applies, as do provider cooldowns when the
  call names a provider.

### Out of scope

Bypasses of the following kinds are known limits, not vulnerabilities:

- Obfuscated or indirect shell commands, including scripts that delete files.
- PowerShell removal commands such as `Remove-Item`, and `find -delete`.
- Targets hidden in variables. Variables are not expanded; only home directory variables such as
  `$HOME` and `%USERPROFILE%` are recognized.
- Other destructive commands, and other spellings of the Git ones, such as `git -C <dir> push -f` or
  a `+` refspec.
- Any other tool, including other shells, notebook edits, other MCP tools, and other ways to start an
  agent.
- Reading secret files, writing them through `Bash`, or secret files with names not listed above.
- Speed modes requested under other key names or values, or nested deeper than the scan.
- Changes to the hooks, `settings.json`, the config, `catalog.overrides.json`, the cooldown file or the
  availability file by anyone who can write them. The guards do not protect these files.
- False positives, such as `echo rm -rf .` being blocked. Report these as normal bugs.

A documented guard that fails on a plain, direct form of what it claims to block is in scope.

## Credentials, network and telemetry

- t3-auto-build does not scrape tokens or credentials. It never opens provider credential files:
  provider detection only checks whether CLI binaries and provider config directories exist.
- `init` reads `settings.json` and, when it changes it, keeps `settings.json.bak`. The backup holds
  everything the original held, including any secret stored there.
- Nothing is sent anywhere: the package's own code opens no network connections. `trace record` appends
  to a local ledger, `<config dir>/auto-build-ledger.jsonl`, holding only time, level, shape, effort,
  step, provider, model, outcome, failover source and duration. Text is cut to 120 characters, so do not
  put secrets in it. It rotates to `.1` at `telemetry.maxBytes` (default 1 MiB), is disabled by
  `telemetry.enabled: false`, and is kept by `uninstall`.
- It runs official provider CLIs, which may use the network, for model probes (`sync-models`,
  `init --probe`, and `check-models` or `preflight` when the cache is stale or with `--refresh`; lock
  rechecks also probe), version checks (`check-models`, `preflight`, `doctor`) and login status
  checks (`quota check`). Probes spend real quota. The installed `$auto-build` skill runs `preflight`
  before it delegates. Scarce-quota models are probed only with `--probe-scarce`.
- Those CLIs use their own stored login and inherit your environment. An API key variable may cause
  probes to be billed to the API.
- `check-models` and `preflight` also run any command listed under `discovery` in the config.
  Treat the config as executable: do not use one you did not write or review.
- `preflight` and `doctor --fix` run `git` in the project directory. Hooks also run local tools found on
  `PATH`: `git` in the project directory, and the formatters
  `biome`, `prettier`, `ruff` or `gofmt` on edited files. These tools can load project configuration,
  and some formatters load project plugins, so treat an untrusted repository accordingly.

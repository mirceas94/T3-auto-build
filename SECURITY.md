# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Any other | No |

## Reporting a vulnerability

Report privately, and only through
[GitHub security advisories](https://github.com/mirceas94/t3-auto-build/security/advisories/new).
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
| Delegate models | `delegate_task` | A banned or non-allowlisted model |
| Cooldowns | `delegate_task` | A model, provider or heavy tier with an active cooldown |

The model and provider fields are read from the top level of the tool input and from `target`.

### Fail-open behavior

- Empty or malformed hook input, and unexpected errors inside the hook, allow the tool call.
- An unreadable cooldown file, or an invalid cooldown entry, is ignored with a warning. Other valid
  entries still apply.
- An invalid or unreadable config does **not** disable the allowlist: the affected settings fall back
  to preset defaults.
- A `delegate_task` call without a model skips the allowlist check. Provider cooldowns still apply
  when it names a provider.

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
- Changes to the hooks, `settings.json`, the config or the cooldown file by anyone who can write
  them. The guards do not protect these files.
- False positives, such as `echo rm -rf .` being blocked. Report these as normal bugs.

A documented guard that fails on a plain, direct form of what it claims to block is in scope.

## Credentials, network and telemetry

- t3-auto-build does not scrape tokens or credentials. It never opens provider credential files:
  provider detection only checks whether CLI binaries and provider config directories exist.
- `init` reads `settings.json` and, when it changes it, keeps `settings.json.bak`. The backup holds
  everything the original held, including any secret stored there.
- There is no telemetry, and the package's own code opens no network connections.
- It runs official provider CLIs, which may use the network, only for model probes (`sync-models`,
  `init --probe`) and login status checks (`quota check`). Probes spend real quota.
- Those CLIs use their own stored login and inherit your environment. An API key variable may cause
  probes to be billed to the API.
- Hooks also run local tools found on `PATH`: `git` in the project directory, and the formatters
  `biome`, `prettier`, `ruff` or `gofmt` on edited files. These tools can load project configuration,
  and some formatters load project plugins, so treat an untrusted repository accordingly.

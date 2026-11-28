# Contributing

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in an issue or pull
request.

## Local setup

You need Node 18.18 or newer and Git. There is nothing to install.

```sh
git clone https://github.com/mirceas94/T3-auto-build.git
cd T3-auto-build
tmp="$(mktemp -d)" && HOME="$tmp" USERPROFILE="$tmp" APPDATA="$tmp/roaming" LOCALAPPDATA="$tmp/local" T3AB_QUOTA_READERS=off node --test; rm -rf "$tmp"
```

To try the CLI without touching your own configuration, point it at a throwaway directory:

```sh
node bin/cli.mjs init --yes --target .sandbox-claude
node bin/cli.mjs doctor --target .sandbox-claude
```

`.sandbox-claude/` is gitignored. `test/sanitize.test.mjs` scans tracked files and untracked
non-ignored files via `git ls-files -co --exclude-standard` (falling back to walking the tree,
skipping `.git` and `CACHEDIR.TAG` caches, only when `git` is unavailable), so `.sandbox-claude/`
is skipped under Git; delete it afterwards anyway if you run tests without Git.

## Rules

- **Zero dependencies.** Import only `node:*` modules and files from this repository. Do not add
  `dependencies` or `devDependencies`.
- **Node 18.18 or newer.** Do not use APIs that Node 18.18 lacks.
- **Self-contained hooks.** Only `hooks/*.mjs` is installed, so a hook must never import from `lib/`.
- **Cross-platform.** Code must work on Windows, macOS and Linux, including paths with spaces.
- **Sanitized files.** `test/sanitize.test.mjs` rejects user-profile paths with a concrete user name,
  and any email address that does not contain `noreply`. Use placeholders such as `<name>`, `$HOME`
  or `%USERPROFILE%`.

## Tests

Run the suite with temporary `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` outside the repo
and `T3AB_QUOTA_READERS=off`:

```sh
# macOS / Linux
tmp="$(mktemp -d)" && HOME="$tmp" USERPROFILE="$tmp" APPDATA="$tmp/roaming" LOCALAPPDATA="$tmp/local" T3AB_QUOTA_READERS=off node --test; rm -rf "$tmp"
```

```powershell
# Windows (PowerShell). Run in a new window and close it afterwards: it changes HOME.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("t3ab-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:HOME=$tmp; $env:USERPROFILE=$tmp; $env:APPDATA="$tmp\roaming"; $env:LOCALAPPDATA="$tmp\local"; $env:T3AB_QUOTA_READERS="off"
node --test --test-reporter=spec
Remove-Item -Recurse -Force $tmp
```

- Add or update a test for every behavior change.
- Tests must never read or write your real `~/.claude` or home skill mirrors. Use `sandbox()` from
  `test/helpers.mjs`, which runs in a temporary directory and overrides `HOME`, `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR`, `PATH` (stripped of provider CLI shims) and
  `T3AB_QUOTA_READERS=off` for subprocesses, plus `PATH`, `T3AB_QUOTA_READERS`, `APPDATA` and
  `LOCALAPPDATA` in-process. Because `process.env.HOME` and `process.env.USERPROFILE` are not
  overridden in-process, bare `node --test` can let in-process `upgrade()` or `syncModels()` tests
  touch real home skill mirrors; always pass the temporary home env vars above (or pass
  `skillTargets: 'none'` when calling `install()` directly).
- Tests must not call real provider CLIs or spend quota. Inject a fake runner.

## Adding a tier or model

The subscription catalog lives in `hooks/_catalog.mjs` (shared models, pools, and retired list) and `lib/plans.mjs` (tier rosters and ladder resolution).

- **Model:** add it to `MODELS` in `hooks/_catalog.mjs` with its provider, `family` and numeric `version`. Drift detection
  treats a higher version in the same family as its replacement. Add it to the role lists in
  `PREFERENCE` and to the tier rosters in `lib/plans.mjs` that include it.
- **Pool:** a model outside the `standard` pool is `scarceQuota`. Add a new pool to `POOLS` and `SCARCE_POOL` in `hooks/_catalog.mjs`, and set the
  tier's `subCaps` in `lib/plans.mjs`. A cross-hosted model goes in the
  hosting tier's `cross` list.
- **Tier:** add it in `claudeTiers`, `codexTiers` or `antigravityTiers` with its models, builder count,
  warning and, for Claude, parent default and options. Add the id to the tier dropdown in
  `.github/ISSUE_TEMPLATE/bug_report.yml`.
- **Ladders:** they are resolved from `PREFERENCE`. Native standard models come first; scarce and
  cross-hosted entries are overflow and stay last.
- **Retiring a model:** add it to `RETIRED_MODELS` in `hooks/_catalog.mjs` and remove it from every
  list, including `PARENTS`. A retired id must never appear in the catalog. A pattern ending in `-*` covers all variants.
- **Defaults:** if the model belongs to the v1 preset roster, update `DEFAULTS` in
  `hooks/_shared.mjs` and `presets/*.json` together. A new model name prefix also needs
  `inferProvider`.
- **Tests:** update `test/plans.test.mjs`, plus `test/shared.test.mjs`, `test/install.test.mjs` and
  `test/template.test.mjs` where they list the changed ids, then run `node --test`. Update
  `README.md` and add a `CHANGELOG.md` entry.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`fix(quota): keep the longer lock` or `docs: clarify guard limits`.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Keep diffs small; do not reformat unrelated lines.
- Update `README.md` when behavior or options change, and `SECURITY.md` when a guard changes.
- Make sure `node --test` passes and complete the pull request checklist.

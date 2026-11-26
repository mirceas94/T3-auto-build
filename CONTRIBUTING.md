# Contributing

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in an issue or pull
request.

## Local setup

You need Node 18.18 or newer and Git. There is nothing to install.

```sh
git clone https://github.com/mirceas94/t3-auto-build.git
cd t3-auto-build
node --test
```

To try the CLI without touching your own configuration, point it at a throwaway directory:

```sh
node bin/cli.mjs init --yes --target .sandbox-claude
node bin/cli.mjs doctor --target .sandbox-claude
```

`.sandbox-claude/` is gitignored. Run `node --test` before creating it, or delete it first: the
sanitize test scans every file in the working tree, and the installed hook commands contain your
absolute path.

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

```sh
node --test
```

- Add or update a test for every behavior change.
- Tests must never read or write your real `~/.claude`. Use `sandbox()` from `test/helpers.mjs`,
  which runs in a temporary directory and overrides `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`.
  When calling library functions directly, pass a temporary target.
- Tests must not call real provider CLIs or spend quota. Inject a fake runner.

## Adding a tier or model

The subscription catalog lives in `lib/plans.mjs`. It is pure data and logic: no filesystem or
processes.

- **Model:** add it to `MODELS` with its provider, `family` and numeric `version`. Drift detection
  treats a higher version in the same family as its replacement. Add it to the role lists in
  `PREFERENCE` and to the tier rosters that include it.
- **Pool:** a model outside the `standard` pool is `scarceQuota`. Add a new pool to `POOLS`, set the
  tier's `subCaps`, and check `SCARCE_POOL` in `hooks/_quota.mjs`. A cross-hosted model goes in the
  hosting tier's `cross` list.
- **Tier:** add it in `claudeTiers`, `codexTiers` or `antigravityTiers` with its models, builder count,
  warning and, for Claude, parent default and options. Add the id to the tier dropdown in
  `.github/ISSUE_TEMPLATE/bug_report.yml`.
- **Ladders:** they are resolved from `PREFERENCE`. Native standard models come first; scarce and
  cross-hosted entries are overflow and stay last.
- **Retiring a model:** add it to `RETIRED_MODELS` in `hooks/_shared.mjs` and remove it from every
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

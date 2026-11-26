# Contributing

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in an issue or pull
request.

## Local setup

You need Node 18 or newer and Git. There is nothing to install.

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
- **Node 18 or newer.** Do not use APIs that Node 18 lacks.
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

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`fix(quota): keep the longer lock` or `docs: clarify guard limits`.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Keep diffs small; do not reformat unrelated lines.
- Update `README.md` when behavior or options change, and `SECURITY.md` when a guard changes.
- Make sure `node --test` passes and complete the pull request checklist.

# Global Coding & Token Discipline

## Search & Read Rules
- Do not re-read files or re-run searches already present in the current context unless a file was modified since the last read.
- Never read entire files over 200 lines upfront. Locate symbols first with `rg -n` or `rg --files`, then read targeted 80-120 line windows using `offset` and `limit`.
- Batch independent read-only searches/reads in parallel instead of sequential single-file turns.
- Check `.claude/repo-profile.md` first if it exists in the repo before scanning directory trees.

## Shell & Test Output Rules
- Always pass quiet/concise flags to test, lint, and build commands so passing logs do not flood context:
  - Python: `pytest -q --tb=short`, `ruff check --output-format=concise`, `mypy --no-error-summary`
  - Node/TS: `npm test -- --silent` or `vitest run --reporter=dot`, `tsc --noEmit --pretty false`
  - Go/Rust: `go test ./...` (avoid `-v` unless debugging a failure), `cargo test -q`
- Never pipe large logs to stdout without `| Select-Object -Last 40` (PowerShell) or `| tail -n 40` (bash) when debugging noisy builds.

## Editing & Diff Discipline
- Keep diffs minimal and scoped strictly to the requested change. Do not reformat unrelated lines.
- Use `git diff -U5` when reviewing changes.
- Respect `.gitignore` and never read or edit `.env`, credentials, keys, or secrets.

## Communication Style
- Lead directly with the answer, action, or diff summary. Skip filler intros and restating the prompt.
- Report findings as `file:line` bullets. Keep explanations under 5 lines unless asked for depth.

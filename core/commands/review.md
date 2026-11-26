Review current uncommitted changes (`git diff -U5` and untracked code files).
- Do not modify files.
- Check for logic bugs, edge cases, missing validation, type errors, and unintended scope creep.
- Output ONLY `file:line` findings grouped by severity (Blocker / Warning / Nit), or `No issues found.` if clean.

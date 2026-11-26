Fix the issue described in `$ARGUMENTS`:
1. Locate the root cause using `rg -n` and targeted line-range reads.
2. Add or run a targeted failing test first if none exists.
3. Apply the smallest scoped fix without touching unrelated code.
4. Run targeted tests + linter/typechecker with concise flags (`-q --tb=short`) and report `file:line` changes.

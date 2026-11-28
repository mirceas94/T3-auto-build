## Summary

<!-- What changes, and why. -->

## Checklist

- [ ] Tests pass (run with isolated temp `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` and `T3AB_QUOTA_READERS=off`).
- [ ] Tests cover the behavior change and do not touch the real `~/.claude` or home skill mirrors.
- [ ] No new dependencies (`node:*` only), and Node 18 still works.
- [ ] No user-profile paths, non-noreply email addresses or secrets.
- [ ] Commits follow Conventional Commits.
- [ ] `README.md` and `SECURITY.md` are updated if behavior or guards changed.

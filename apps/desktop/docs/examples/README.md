# Desktop examples (Phase C)

These artifacts are **documentation only**. They do not change Grox Desktop runtime behavior.

| File | Purpose |
|------|---------|
| `ci-headless.yml` | GitHub Actions sketch for `grok -p` headless checks |
| `snippets.md` | Copy-paste CLI fragments (sandbox / worktree / inspect) |

## Principles

- Default open: do not force sandbox or enterprise trust gates
- Secrets stay in CI secret stores — never commit keys
- Worktrees via `grok worktree` / `grok --worktree` only
- Desktop feature flags can hide related UI without affecting these docs

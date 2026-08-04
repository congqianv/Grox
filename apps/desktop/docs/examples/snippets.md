# Copy-paste CLI snippets

## Inspect (Effective panel source)

```bash
grok inspect --json
```

## Follow CLI sandbox (default)

```bash
# Do not set GROK_SANDBOX — agent uses CLI defaults
grok agent --leader stdio
```

## Explicit sandbox (only when intentional)

```bash
grok -p "run tests" --sandbox workspace
# or
GROK_SANDBOX=read-only grok -p "review only"
```

## Worktree (no raw git worktree dual track)

```bash
grok worktree list --json
grok --worktree=feat-foo -p "implement the feature"
```

## Headless one-shot

```bash
grok -p "Explain src/main entrypoints" --permission-mode default
```

## Review-leaning (permission confirm)

```bash
grok -p "Security review of auth module" --permission-mode default --sandbox read-only
```

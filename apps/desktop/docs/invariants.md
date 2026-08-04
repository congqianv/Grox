# Desktop invariants (Codex migration guardrails)

Must hold after every PR on the capability-migration track. Run:

```text
cd apps/desktop && pnpm test
```

Focus suites: `permissionAuto`, `queueTurnPolicy`, `promptQueue`, `sessionGate`, `firstEventWatch`, `computerUse`, plus pure modules (`featureFlags`, `sandboxPolicy`, `effectiveRuntime`, `grokInspect`, `worktreePolicy`, `concurrentSessions`, `reviewPreset`, `activeProcesses`).

| ID | Invariant |
|----|-----------|
| I-01 | Drain prompt queue only when session is idle; Stop suppresses drain |
| I-02 | Opening gate must not drop permission / plan / question cards |
| I-03 | In-flight turn must not half-apply a new sandbox preference |
| I-04 | Computer Use only via operator opt-in (not Bypass) |
| I-05 | Media tools remain allowlisted |
| I-06 | Failed worktree bind must not create a session with invalid cwd |
| I-07 | Queue ghost / consumed semantics stay intact under new UI |
| I-08 | Feature flag off ≈ pre-slice spawn / behavior |

## UI honesty

- Dual-state: **requested** vs **applied \| unknown**
- Never show green “isolated” when applied is unknown (inspect degrade path)
- Default sandbox preference is **follow CLI** (no shell-forced sandbox)

## Shell constraints

- No OS sandbox implemented in the desktop shell
- Worktrees only via `grok worktree` (no parallel raw `git worktree` track)
- ACP spawn remains `grok agent … stdio` via Tauri; Lite shell only

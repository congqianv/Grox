# Upstream RFC notes (desktop shell)

Gaps that the Lite shell **must not fake**. Track here; do not implement agent-side enforcement in this repo.

| ID | Gap | Shell behavior until upstream |
|----|-----|-------------------------------|
| U-01 | Applied sandbox not reported on ACP wire | Dual-state `applied: unknown`; no green “isolated” |
| U-04 | Richer subagent lifecycle events | Best-effort from existing tool/task blocks |
| U-06 | Headless CI contract surface | `docs/examples` only (Phase C) |
| U-14 | `grok inspect` schema stability / sandbox fields | Parse known keys; ignore extras; degrade on parse fail |

Shell constraints:

- No OS sandbox in desktop
- Worktree only via `grok worktree`
- Spawn remains `grok agent … stdio` through Tauri `acp_spawn`

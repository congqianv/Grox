/**
 * Worktree bind policy (A2).
 * Shell only uses `grok worktree` / `grok --worktree` — never a parallel git worktree track.
 * Default bind mode is Local (I-06: failed bind must not create invalid-cwd sessions).
 */

export type WorkspaceBindMode = "local" | "worktree";

export const DEFAULT_WORKSPACE_BIND_MODE: WorkspaceBindMode = "local";

export interface WorktreeEntry {
  id: string;
  path: string;
  name?: string;
  branch?: string;
  repo?: string;
}

export type WorktreeBindResult =
  | { ok: true; path: string; entry: WorktreeEntry }
  | { ok: false; reason: "empty_path" | "missing_path" | "not_directory" | "invalid_entry" };

/**
 * Normalize `grok worktree list --json` (array or `{ worktrees: [] }`).
 * Tolerant of field aliases — upstream schema may evolve (U-14).
 */
export function parseWorktreeList(raw: unknown): WorktreeEntry[] {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.worktrees)) rows = obj.worktrees;
    else if (Array.isArray(obj.items)) rows = obj.items;
    else if (Array.isArray(obj.entries)) rows = obj.entries;
  }

  const out: WorktreeEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const path = firstString(r, ["path", "cwd", "worktreePath", "dir", "directory"]);
    if (!path) continue;
    const id =
      firstString(r, ["id", "worktreeId", "name", "slug"]) ?? path;
    out.push({
      id,
      path,
      name: firstString(r, ["name", "title", "label", "slug"]),
      branch: firstString(r, ["branch", "headBranch", "ref"]),
      repo: firstString(r, ["repo", "repository", "repoPath", "source"]),
    });
  }
  return out;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Validate a worktree entry before creating/focusing a session (I-06).
 * `pathExists` / `pathIsDirectory` are injected so tests stay pure.
 */
export function bindWorktreePath(
  entry: Pick<WorktreeEntry, "path" | "id"> | null | undefined,
  checks: {
    pathExists(path: string): boolean;
    pathIsDirectory(path: string): boolean;
  },
): WorktreeBindResult {
  if (!entry || typeof entry.path !== "string") {
    return { ok: false, reason: "invalid_entry" };
  }
  const path = entry.path.trim();
  if (!path) return { ok: false, reason: "empty_path" };
  if (!checks.pathExists(path)) return { ok: false, reason: "missing_path" };
  if (!checks.pathIsDirectory(path)) return { ok: false, reason: "not_directory" };
  return {
    ok: true,
    path,
    entry: { id: entry.id || path, path },
  };
}

/** Soft label for UI when list fails (no git / no grok / empty). */
export function worktreeListDegradeMessage(
  status: "ok" | "error" | "unavailable" | "empty",
  zh: boolean,
): string {
  switch (status) {
    case "empty":
      return zh ? "尚无 worktree；可创建或使用 Local" : "No worktrees yet — create one or use Local";
    case "unavailable":
      return zh
        ? "worktree 不可用（浏览器/Mock 或 CLI 缺失）— 并行请用多 session"
        : "Worktree unavailable (browser/mock or missing CLI) — use multi-session for parallel work";
    case "error":
      return zh
        ? "worktree 列表失败 — 仍可使用 Local / 多 session"
        : "Worktree list failed — Local / multi-session still work";
    default:
      return "";
  }
}

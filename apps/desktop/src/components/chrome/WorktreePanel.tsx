/* A2 — Local vs Worktree picker (default Local). Uses grok worktree only. */

import { useCallback, useEffect, useState } from "react";
import { baseName } from "../../lib/format";
import {
  worktreeListDegradeMessage,
  type WorktreeEntry,
} from "../../lib/worktreePolicy";
import { useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";

export function WorktreePanel({ zh }: { zh: boolean }) {
  const enabled = useIsFeatureEnabled("worktreeUi");
  const workspace = useDesktop((s) => s.workspace);
  const listWorktrees = useDesktop((s) => s.listWorktrees);
  const createWorktree = useDesktop((s) => s.createWorktree);
  const openWorktree = useDesktop((s) => s.openWorktree);
  const bridgeKind = useDesktop((s) => s.bridgeKind);
  const [entries, setEntries] = useState<WorktreeEntry[]>([]);
  const [status, setStatus] = useState<"ok" | "error" | "unavailable" | "empty" | "loading">(
    "loading",
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (bridgeKind !== "acp") {
      setStatus("unavailable");
      setEntries([]);
      return;
    }
    setStatus("loading");
    try {
      const list = await listWorktrees();
      setEntries(list);
      setStatus(list.length === 0 ? "empty" : "ok");
    } catch {
      setEntries([]);
      setStatus("error");
    }
  }, [bridgeKind, enabled, listWorktrees]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, workspace]);

  if (!enabled) return null;

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const entry = await createWorktree(trimmed);
      if (entry) {
        setName("");
        setNotice(zh ? `已创建 ${entry.name ?? entry.id}` : `Created ${entry.name ?? entry.id}`);
        await refresh();
      } else {
        // Read store immediately — React hook state may still be stale after await.
        const blocked = useDesktop.getState().queueNotice;
        const detail = blocked?.state === "blocked" ? blocked.message : "";
        setNotice(
          detail ||
            (zh
              ? "创建失败或路径未确认（未打开会话）"
              : "Create failed or path unconfirmed (no session opened)"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const onOpen = async (entry: WorktreeEntry) => {
    setBusy(true);
    setNotice("");
    try {
      const ok = await openWorktree(entry);
      const blocked = useDesktop.getState().queueNotice;
      const failDetail = blocked?.state === "blocked" ? blocked.message : "";
      setNotice(
        ok
          ? zh
            ? `已切换到 worktree：${baseName(entry.path)}`
            : `Switched to worktree: ${baseName(entry.path)}`
          : failDetail ||
              (zh
                ? "打开失败（无效路径，未建会话）"
                : "Open failed (invalid path; no session created)"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2 mb-2 rounded-[6px] border border-line bg-void/80 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[10px] font-medium tracking-wide text-mute">
          {zh ? "工作区绑定" : "Workspace bind"}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto flex h-6 w-6 items-center justify-center text-dim hover:bg-high hover:text-fg"
          title={zh ? "刷新 worktree 列表" : "Refresh worktrees"}
        >
          <Icon name="refresh" size={10} className={status === "loading" ? "animate-orbit" : ""} />
        </button>
      </div>

      <p className="mb-2 text-[10px] leading-snug text-faint">
        {zh
          ? "默认使用当前 Local 项目。Worktree 可选，失败不挡聊天。"
          : "Default is the current Local project. Worktree is optional."}
      </p>

      <div className="mb-1.5 rounded-[5px] border border-line2 bg-raise/60 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <Icon name="folder" size={13} className="shrink-0 text-mute" />
          <span className="text-[11px] text-fg2">{zh ? "Local（当前）" : "Local (current)"}</span>
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-mute" title={baseName(workspace)}>
          {baseName(workspace) || "—"}
        </p>
        <p className="mt-0.5 break-all font-mono text-[9px] leading-snug text-faint" title={workspace}>
          {workspace}
        </p>
      </div>

      {status !== "ok" && status !== "loading" && (
        <p className="mb-2 text-[10px] leading-snug text-dim">
          {worktreeListDegradeMessage(status === "empty" ? "empty" : status, zh)}
        </p>
      )}

      {entries.length > 0 && (
        <div className="mb-2 max-h-28 space-y-0.5 overflow-y-auto">
          {entries.map((entry) => (
            <button
              key={entry.id + entry.path}
              type="button"
              disabled={busy}
              onClick={() => void onOpen(entry)}
              className="flex w-full flex-col items-start rounded-[5px] border border-line px-2.5 py-1.5 text-left hover:bg-high disabled:opacity-40"
              title={entry.path}
            >
              <span className="flex w-full items-center gap-1.5">
                <Icon name="branch" size={12} className="shrink-0 text-mute" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-mute">
                  {entry.name ?? entry.id}
                </span>
                {entry.branch && (
                  <span className="max-w-[72px] truncate font-mono text-[9px] text-faint">
                    {entry.branch}
                  </span>
                )}
              </span>
              <span className="mt-0.5 w-full truncate pl-5 font-mono text-[9px] text-faint">
                {entry.path}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void onCreate()}
          placeholder={zh ? "新建 worktree 名称…" : "New worktree name…"}
          maxLength={80}
          className="h-7 min-w-0 flex-1 rounded-[4px] border border-line2 bg-raise px-2 font-mono text-[10px] text-fg2 outline-none focus:border-line3"
        />
        <button
          type="button"
          disabled={!name.trim() || busy || bridgeKind !== "acp"}
          onClick={() => void onCreate()}
          className="summary-action disabled:opacity-40"
        >
          {busy ? "…" : zh ? "创建" : "Create"}
        </button>
      </div>
      {notice && <p className="mt-1.5 text-[9.5px] leading-snug text-dim">{notice}</p>}
    </div>
  );
}

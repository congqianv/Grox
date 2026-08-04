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
        setNotice(zh ? "创建失败或路径未确认（未打开会话）" : "Create failed or path unconfirmed (no session opened)");
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
      setNotice(
        ok
          ? zh
            ? `已切换到 worktree：${baseName(entry.path)}`
            : `Switched to worktree: ${baseName(entry.path)}`
          : zh
            ? "打开失败（无效路径，未建会话）"
            : "Open failed (invalid path; no session created)",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2 mb-2 rounded-[6px] border border-line bg-void/80 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="lbl !text-[9px] !tracking-[0.1em]">
          {zh ? "工作区绑定" : "WORKSPACE BIND"}
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

      <p className="mb-2 font-mono text-[9.5px] text-faint">
        {zh ? "默认 Local（当前项目）。Worktree 可选。" : "Default Local (current project). Worktree optional."}
      </p>

      <div className="summary-row mb-1">
        <Icon name="folder" size={13} className="text-mute" />
        <span className="min-w-0 flex-1 truncate text-left">{zh ? "Local（当前）" : "Local (current)"}</span>
        <span className="max-w-[140px] truncate font-mono text-[9px] text-faint" title={workspace}>
          {baseName(workspace)}
        </span>
      </div>

      {status !== "ok" && status !== "loading" && (
        <p className="mb-2 px-1 font-mono text-[9.5px] text-dim">
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
              className="summary-row w-full disabled:opacity-40"
              title={entry.path}
            >
              <Icon name="branch" size={12} className="text-mute" />
              <span className="min-w-0 flex-1 truncate text-left text-mute">
                {entry.name ?? entry.id}
              </span>
              {entry.branch && (
                <span className="max-w-[72px] truncate font-mono text-[9px] text-faint">
                  {entry.branch}
                </span>
              )}
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
          {busy ? (zh ? "…" : "…") : zh ? "创建" : "Create"}
        </button>
      </div>
      {notice && (
        <p className="mt-1.5 px-1 font-mono text-[9px] text-dim">{notice}</p>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop } from "../../state/store";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { baseName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { isSafeMarkdownOpenUrl } from "../../lib/openUrlSafety";
import { Icon } from "../fx/Icon";
import { EffectiveRuntimePanel } from "./EffectiveRuntimePanel";
import { WorktreePanel } from "./WorktreePanel";

interface GitSummary {
  isRepository: boolean;
  branch?: string;
  branches: string[];
  added: number;
  removed: number;
  changedFiles: number;
  remoteUrl?: string;
  defaultBranch?: string;
  ahead: number;
  behind: number;
}

interface SummarySource {
  id: string;
  kind: "attachment" | "link";
  label: string;
  url?: string;
}

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** Dual-gate source/compare URLs before open_external (R20). */
function openSafeExternal(raw: string) {
  try {
    const url = new URL(raw);
    if (!isSafeMarkdownOpenUrl(url)) return;
    if (inTauri()) void invoke("open_external", { url: url.toString() });
    else window.open(url.toString(), "_blank", "noopener,noreferrer");
  } catch {
    // invalid URL — ignore
  }
}

const githubBaseUrl = (remote?: string) => {
  if (!remote) return null;
  const ssh = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/i, "")}`;
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return `${url.origin}${url.pathname.replace(/\.git$/i, "").replace(/\/$/, "")}`;
  } catch {
    return null;
  }
};

const linksFromText = (text: string) =>
  text.match(/https?:\/\/[^\s<>"')\]]+/g)?.map((url) => url.replace(/[.,;:!?]+$/, "")) ?? [];

export function EnvironmentSummary() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"checkout" | "commit" | "push" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [showAllSources, setShowAllSources] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const workspace = useDesktop((state) => state.workspace);
  const activeId = useDesktop((state) => state.activeId);
  const session = useDesktop((state) => (state.activeId ? state.sessions[state.activeId] : null));
  const composer = useDesktop((state) => (state.activeId ? state.sessionComposers[state.activeId] : null));
  const setComposerAttachments = useDesktop((state) => state.setComposerAttachments);
  const openProjectInExplorer = useDesktop((state) => state.openProjectInExplorer);

  const sources = useMemo<SummarySource[]>(() => {
    const items = new Map<string, SummarySource>();
    for (const attachment of composer?.attachments ?? []) {
      items.set(`attachment:${attachment.name}`, {
        id: `composer-${attachment.id}`,
        kind: "attachment",
        label: attachment.name,
      });
    }
    for (const block of session?.blocks ?? []) {
      if (block.type === "user") {
        for (const attachment of block.attachments ?? []) {
          const key = `attachment:${attachment.name}`;
          if (!items.has(key)) items.set(key, { id: attachment.id, kind: "attachment", label: attachment.name });
        }
      }
      if (block.type === "user" || block.type === "assistant") {
        for (const url of linksFromText(block.text)) {
          if (!items.has(url)) items.set(url, { id: url, kind: "link", label: url.replace(/^https?:\/\//, ""), url });
        }
      }
    }
    return [...items.values()];
  }, [composer?.attachments, session]);

  const loadSummary = async () => {
    setLoading(true);
    setError("");
    try {
      if (inTauri()) {
        setSummary(await invoke<GitSummary>("git_summary", { cwd: workspace }));
      } else {
        setSummary({
          isRepository: true,
          branch: "main",
          branches: ["main", "feature/summary-card"],
          added: 220,
          removed: 31,
          changedFiles: 4,
          remoteUrl: "https://github.com/dandandujie/Grox.git",
          defaultBranch: "main",
          ahead: 0,
          behind: 0,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadSummary();
  }, [open, workspace]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const runAction = async (kind: "checkout" | "commit" | "push", action: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const result = await action();
      setNotice(result);
      await loadSummary();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const checkout = (branch: string) => {
    if (!branch || branch === summary?.branch) return;
    if (!window.confirm(zh ? `切换到分支 ${branch}？未提交的变更将保留。` : `Switch to ${branch}? Uncommitted changes will be kept.`)) return;
    void runAction("checkout", () =>
      inTauri() ? invoke<string>("git_checkout", { cwd: workspace, branch }) : Promise.resolve(zh ? `已切换到 ${branch}` : `Switched to ${branch}`),
    );
  };

  const commit = () => {
    const message = commitMessage.trim();
    if (!message) return;
    if (!window.confirm(zh ? "确认暂存全部变更并创建提交？" : "Stage all changes and create this commit?")) return;
    void runAction("commit", () =>
      inTauri() ? invoke<string>("git_commit", { cwd: workspace, message }) : Promise.resolve(zh ? "提交已创建" : "Commit created"),
    ).then((succeeded) => {
      if (succeeded) {
        setCommitMessage("");
        setCommitOpen(false);
      }
    });
  };

  const push = () => {
    if (!window.confirm(zh ? "确认将当前分支推送到 origin？" : "Push the current branch to origin?")) return;
    void runAction("push", () =>
      inTauri() ? invoke<string>("git_push", { cwd: workspace }) : Promise.resolve(zh ? "推送已完成" : "Push completed"),
    );
  };

  const openCompare = () => {
    const base = githubBaseUrl(summary?.remoteUrl);
    const branch = summary?.branch;
    if (!base || !branch) return;
    const target = `${base}/compare/${encodeURIComponent(summary?.defaultBranch ?? "main")}...${encodeURIComponent(branch)}`;
    openSafeExternal(target);
  };

  const addSources = async (files: FileList | null) => {
    if (!files || !activeId) return;
    setError("");
    try {
      const prepared = await Promise.all([...files].map((file) => prepareAttachment(file)));
      const next = [...(composer?.attachments ?? []), ...prepared];
      validateAttachmentSet(next);
      setComposerAttachments(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const visibleSources = showAllSources ? sources : sources.slice(0, 4);
  const compareAvailable = Boolean(
    githubBaseUrl(summary?.remoteUrl)
      && summary?.branch
      && summary.branch !== (summary.defaultBranch ?? "main"),
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        className={`chip ${open ? "!border-line3 !text-fg2" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title={zh ? "环境摘要" : "Environment summary"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Icon name="summary" size={12} />
      </button>

      {open && (
        <section
          role="dialog"
          aria-label={zh ? "环境摘要" : "Environment summary"}
          className="absolute right-0 top-[calc(100%+9px)] z-[80] max-h-[calc(100vh-52px)] w-[min(380px,calc(100vw-20px))] overflow-y-auto rounded-[10px] border border-line2 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.58)] animate-fade-up"
        >
          <div className="flex h-11 items-center border-b border-line px-4">
            <span className="lbl !text-[10px] !tracking-[0.12em]">{zh ? "环境信息" : "ENVIRONMENT"}</span>
            <button
              onClick={() => void loadSummary()}
              className="ml-auto flex h-7 w-7 items-center justify-center text-dim hover:bg-high hover:text-fg"
              title={zh ? "刷新" : "Refresh"}
            >
              <Icon name="refresh" size={11} className={loading ? "animate-orbit" : ""} />
            </button>
          </div>

          <div className="p-3">
            <EffectiveRuntimePanel zh={zh} />
            <WorktreePanel zh={zh} />

            <SummaryRow icon="edit" label={zh ? "变更" : "Changes"}>
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px]">
                <span className="text-dim">{summary?.changedFiles ?? 0}</span>
                <span className="text-green">+{summary?.added ?? 0}</span>
                <span className="text-red">−{summary?.removed ?? 0}</span>
              </span>
            </SummaryRow>

            <button onClick={() => void openProjectInExplorer()} className="summary-row w-full" title={workspace}>
              <Icon name="folder" size={14} className="text-mute" />
              <span className="min-w-0 flex-1 truncate text-left">{zh ? "本地" : "Local"}</span>
              <span className="max-w-[72px] truncate text-[10px] text-dim">{baseName(workspace)}</span>
              <span className="max-w-[150px] truncate font-mono text-[9px] text-faint">{workspace}</span>
              <Icon name="external" size={10} className="text-faint" />
            </button>

            <SummaryRow icon="branch" label={summary?.isRepository ? (summary.branch ?? "DETACHED HEAD") : (zh ? "非 Git 仓库" : "Not a Git repository")}>
              {summary?.isRepository && (
                <select
                  value={summary.branch ?? ""}
                  disabled={busy !== null}
                  onChange={(event) => checkout(event.target.value)}
                  className="ml-auto max-w-[145px] bg-transparent text-right font-mono text-[10px] text-dim outline-none"
                  aria-label={zh ? "切换分支" : "Switch branch"}
                >
                  {summary.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              )}
            </SummaryRow>

            {summary?.isRepository && (
              <>
                <button onClick={() => setCommitOpen((value) => !value)} className="summary-row w-full">
                  <Icon name="dot" size={14} className="text-mute" />
                  <span>{zh ? "提交或推送" : "Commit or push"}</span>
                  {(summary.ahead > 0 || summary.behind > 0) && (
                    <span className="ml-auto font-mono text-[9px] text-faint">↑{summary.ahead} ↓{summary.behind}</span>
                  )}
                  <Icon name="chevronDown" size={9} className={`ml-auto text-faint transition-transform ${commitOpen ? "rotate-180" : ""}`} />
                </button>
                {commitOpen && (
                  <div className="mx-2 mb-2 rounded-[6px] border border-line bg-void p-2">
                    <input
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && commit()}
                      placeholder={zh ? "提交说明…" : "Commit message…"}
                      maxLength={200}
                      className="h-8 w-full rounded-[4px] border border-line2 bg-raise px-2.5 text-[10.5px] text-fg2 outline-none focus:border-line3"
                    />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <button disabled={!commitMessage.trim() || busy !== null} onClick={commit} className="summary-action">
                        {busy === "commit" ? (zh ? "提交中…" : "Committing…") : (zh ? "提交全部" : "Commit all")}
                      </button>
                      <button disabled={busy !== null} onClick={push} className="summary-action">
                        {busy === "push" ? (zh ? "推送中…" : "Pushing…") : (zh ? "推送" : "Push")}
                      </button>
                    </div>
                  </div>
                )}

                <button disabled={!compareAvailable} onClick={openCompare} className="summary-row w-full disabled:opacity-35">
                  <Icon name="github" size={14} className="text-mute" />
                  <span>{zh ? "比较分支" : "Compare branch"}</span>
                  <span className="ml-auto font-mono text-[9px] text-faint">{summary.defaultBranch ?? "main"} ← {summary.branch}</span>
                  <Icon name="external" size={10} className="text-faint" />
                </button>
              </>
            )}

            {(error || notice) && (
              <p className={`mx-2 mt-2 rounded-[4px] border border-line px-2 py-1.5 font-mono text-[9px] ${error ? "text-red" : "text-green"}`}>
                {error || notice}
              </p>
            )}

            <div className="mx-2 my-3 h-px bg-line" />

            <div className="flex h-8 items-center px-2">
              <span className="lbl !text-[9.5px]">{zh ? "来源" : "SOURCES"}</span>
              <button
                disabled={!activeId || (composer?.attachments.length ?? 0) >= MAX_ATTACHMENTS}
                onClick={() => fileRef.current?.click()}
                className="ml-auto flex h-7 w-7 items-center justify-center text-dim hover:bg-high hover:text-fg disabled:opacity-30"
                title={zh ? "添加到当前消息" : "Add to current message"}
              >
                <Icon name="plus" size={13} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void addSources(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {visibleSources.length === 0 ? (
              <p className="px-2 py-3 text-[10px] text-faint">{zh ? "当前任务还没有附件或链接来源" : "No attachment or link sources in this mission"}</p>
            ) : (
              <div>
                {visibleSources.map((source) => (
                  <button
                    key={source.id}
                    disabled={!source.url}
                    onClick={() => source.url && openSafeExternal(source.url)}
                    className="summary-row w-full disabled:cursor-default"
                    title={source.label}
                  >
                    <Icon name={source.kind === "link" ? "external" : "file"} size={13} className="text-dim" />
                    <span className="min-w-0 flex-1 truncate text-left text-mute">{source.label}</span>
                  </button>
                ))}
                {sources.length > 4 && (
                  <button onClick={() => setShowAllSources((value) => !value)} className="summary-row w-full !text-dim">
                    <Icon name="layers" size={12} />
                    <span>{showAllSources ? (zh ? "收起" : "Show less") : (zh ? `查看全部 ${sources.length}` : `View all ${sources.length}`)}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryRow({ icon, label, children }: { icon: "edit" | "branch"; label: string; children?: React.ReactNode }) {
  return (
    <div className="summary-row">
      <Icon name={icon} size={14} className="text-mute" />
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </div>
  );
}

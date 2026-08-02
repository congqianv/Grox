/* ─────────────────────────────────────────────────────────────────────────
   Home — mission control. Deep field, the orbital mark, one input, and
   the last few missions. Everything else is silence.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import type { PromptAttachment, WorkspaceEntry } from "../../bridge/types";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import {
  MAX_ATTACHMENTS,
  activeAtQuery,
  attachmentErrorMessage,
  insertAtMention,
  isLongPaste,
  prepareDroppedFile,
  preparePasteAttachment,
  preparePathAttachment,
  searchWorkspaceFiles,
  validateAttachmentSet,
} from "../../lib/attachments";
import { isNativeDragDropActive, listenNativeFileDrop } from "../../lib/dragDrop";
import { useImeGuard } from "../../lib/ime";
import { BlackHole } from "../fx/BlackHole";
import { Starfield } from "../fx/Starfield";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { useI18n } from "../../lib/i18n";
import { MediaStudio } from "./MediaStudio";

const EMPTY_FILES: WorkspaceEntry[] = [];

function attachmentLabel(attachment: PromptAttachment): string {
  if (attachment.kind === "path" && attachment.path) return attachment.path;
  return attachment.name;
}

export function Home() {
  const { language, t } = useI18n();
  const zh = language === "zh-CN";
  const [workspaceMode, setWorkspaceMode] = useState<"conversation" | "image" | "video">(
    "conversation",
  );
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [atIdx, setAtIdx] = useState(0);
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const workspace = useDesktop((s) => s.workspace);
  const workspaceFiles = useDesktop((s) => s.workspaceFiles);
  const refreshWorkspaceFiles = useDesktop((s) => s.refreshWorkspaceFiles);
  const startupError = useDesktop((s) => s.startupError);
  const auth = useDesktop((s) => s.auth);
  const setAccountSetupOpen = useDesktop((s) => s.setAccountSetupOpen);
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const effort = useDesktop((s) => s.effort);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const mode = useDesktop((s) => s.mode);
  const setModel = useDesktop((s) => s.setModel);
  const setEffort = useDesktop((s) => s.setEffort);
  const setPermissionMode = useDesktop((s) => s.setPermissionMode);
  const setMode = useDesktop((s) => s.setMode);

  const recent = [...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  const atMention = useMemo(() => activeAtQuery(q, cursor), [q, cursor]);
  const atOpen = Boolean(atMention);
  const atMatches = useMemo(() => {
    if (!atOpen || !atMention) return EMPTY_FILES;
    return searchWorkspaceFiles(workspaceFiles, atMention.query);
  }, [atOpen, atMention, workspaceFiles]);

  useEffect(() => setAtIdx(0), [atMention?.query, atOpen]);
  useEffect(() => {
    if (atOpen && workspaceFiles.length === 0) void refreshWorkspaceFiles();
  }, [atOpen, workspaceFiles.length, refreshWorkspaceFiles]);

  const applyText = (next: string, nextCursor?: number) => {
    setQ(next);
    if (nextCursor !== undefined) {
      setCursor(nextCursor);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      });
    }
  };

  const appendPrepared = (prepared: PromptAttachment[]) => {
    if (prepared.length === 0) return;
    const next = [...attachments, ...prepared];
    validateAttachmentSet(next);
    setAttachments(next);
  };

  const appendPathStrings = (paths: string[]) => {
    if (paths.length === 0) return;
    setAttachmentError("");
    try {
      appendPrepared(paths.map((path) => preparePathAttachment(path, workspace)));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(attachmentErrorMessage(code, language));
    }
  };

  const pathDropRef = useRef(appendPathStrings);
  pathDropRef.current = appendPathStrings;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listenNativeFileDrop((event) => {
      if (event.phase === "enter" || event.phase === "over") {
        setDragOver(true);
        return;
      }
      if (event.phase === "leave") {
        setDragOver(false);
        return;
      }
      if (event.phase === "drop") {
        setDragOver(false);
        if (event.paths.length > 0) pathDropRef.current(event.paths);
      }
    }).then((fn) => {
      if (cancelled) fn?.();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const prepared: PromptAttachment[] = [];
      for (const file of files) prepared.push(await prepareDroppedFile(file, workspace));
      appendPrepared(prepared);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(attachmentErrorMessage(code, language));
    } finally {
      setReadingFiles(false);
    }
  };

  const parseDroppedPaths = (raw: string): string[] =>
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        if (line.startsWith("file://")) {
          try {
            const url = new URL(line);
            return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
          } catch {
            return line.replace(/^file:\/\//, "");
          }
        }
        return line;
      })
      .filter(Boolean);

  const launch = async () => {
    const prompt = q.trim();
    if ((!prompt && attachments.length === 0) || readingFiles) return;
    // newSession focuses the mission and returns its id; sendPrompt needs that
    // id (activeId was null on Home → silent no-op before this fix).
    const id = await newSession();
    if (!id) return;
    sendPrompt(prompt, attachments, id);
    setQ("");
    setCursor(0);
    setAttachments([]);
    setAttachmentError("");
  };

  const pickAtFile = (entry: WorkspaceEntry) => {
    if (!atMention) return;
    const { text: next, cursor: nextCursor } = insertAtMention(q, atMention.start, cursor, entry.path);
    applyText(next, nextCursor);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const images = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length > 0) {
      event.preventDefault();
      void appendFiles(images);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (pasted && isLongPaste(pasted)) {
      event.preventDefault();
      setAttachmentError("");
      try {
        appendPrepared([preparePasteAttachment(pasted)]);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : String(cause);
        setAttachmentError(attachmentErrorMessage(code, language));
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // IME (e.g. Chinese Pinyin): Enter confirms the candidate, not "send".
    // Also ignore the post-compositionend Enter some WebViews still fire.
    if (isImeBlocking(event)) return;

    if (atOpen && atMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAtIdx((i) => (i + 1) % atMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAtIdx((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pickAtFile(atMatches[Math.min(atIdx, atMatches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void launch();
    }
  };

  const currentModel = models.find((item) => item.id === model);

  if (workspaceMode !== "conversation") {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-base">
        <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />
        <MediaStudio mode={workspaceMode} />
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden bg-base">
      <Starfield />
      <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />

      <div className="relative flex h-full flex-col items-center justify-center px-8 pb-16">
        <BlackHole size={88} spin="slow" />

        <h1 className="mt-6 font-sans text-[32px] font-semibold tracking-tight text-fg">
          Grox
        </h1>
        <p className="mt-2 text-[14px] text-mute">
          {zh ? "今天想构建什么？" : "What are we building today?"}
        </p>

        {startupError && (
          <div className="mt-6 w-[min(560px,100%)] rounded-lg border border-red/20 bg-red/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-red">
                  {/computer\s*use|GROX_COMPUTER_USE|未启用/i.test(startupError)
                    ? zh
                      ? "Computer Use 提示"
                      : "Computer Use notice"
                    : zh
                      ? "连接失败"
                      : "Connection failed"}
                </p>
                <p className="mt-1 break-words text-[12.5px] leading-relaxed text-fg2">
                  {startupError}
                </p>
                {/* Only show CLI install hint for real runtime/CLI failures — not CU opt-in text. */}
                {!/computer\s*use|GROX_COMPUTER_USE|未启用/i.test(startupError) && (
                  <p className="mt-1.5 text-[12px] text-dim">
                    {zh
                      ? "请安装 Grok CLI，或设置 GROK_DESKTOP_CLI 后重启 Grox。"
                      : "Install Grok CLI or set GROK_DESKTOP_CLI, then restart Grox."}
                  </p>
                )}
                {/computer\s*use|GROX_COMPUTER_USE|未启用/i.test(startupError) && (
                  <p className="mt-1.5 text-[12px] text-dim">
                    {zh
                      ? "普通对话不需要打开 Computer Use。若仍无法新建任务，请更新到最新桌面壳（soft-fail 已修复）。设置 → 允许 Computer Use 仅用于 /computer 桌面控制。"
                      : "Normal chat does not need Computer Use. If new missions still fail, update the desktop shell (soft-fail fix). Enable Computer Use only for /computer desktop control."}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {auth.required && (
          <div className="mt-6 flex w-[min(560px,100%)] items-center gap-4 rounded-lg border border-gold/20 bg-gold/5 px-4 py-3">
            <BlackHole size={24} spin={auth.inProgress} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-gold">{zh ? "需要账户设置" : "Sign in required"}</p>
              <p className="mt-1 text-[12.5px] text-fg2">
                {auth.error ?? (zh ? "请先选择 OAuth、官方 API 或 OpenAI 兼容服务。" : "Connect your xAI account before starting.")}
              </p>
            </div>
            <button
              onClick={() => setAccountSetupOpen(true)}
              disabled={auth.inProgress}
              className="flex h-8 shrink-0 items-center rounded-md bg-acc px-3.5 text-[12.5px] font-medium leading-none text-base transition-colors hover:bg-acc-deep disabled:opacity-50"
            >
              {auth.inProgress ? (zh ? "连接中" : "Connecting") : t("account")}
            </button>
          </div>
        )}

        {/* main prompt — floating composer */}
        <div
          className={`surface relative mt-8 w-[min(680px,100%)] overflow-visible transition-shadow ${
            dragOver ? "ring-1 ring-acc/50" : ""
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (isNativeDragDropActive()) return;
            dragDepth.current += 1;
            setDragOver(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => {
            if (isNativeDragDropActive()) return;
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragOver(false);
            if (isNativeDragDropActive()) return;
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0) {
              void appendFiles(files);
              return;
            }
            const uriList =
              event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
            if (uriList.trim()) appendPathStrings(parseDroppedPaths(uriList));
          }}
        >
          {atOpen && atMatches.length > 0 && (
            <div className="absolute bottom-full left-0 z-50 mb-2 max-h-56 w-full overflow-y-auto rounded-lg border border-line2 bg-raise py-1 shadow-[var(--shadow-float)] animate-fade-up">
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                {zh ? "项目文件" : "Project files"}
              </div>
              {atMatches.map((entry, i) => (
                <button
                  key={entry.path}
                  onMouseEnter={() => setAtIdx(i)}
                  onClick={() => pickAtFile(entry)}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                    i === atIdx ? "bg-high" : "hover:bg-high/60"
                  }`}
                >
                  <Icon name="file" size={11} className="shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-none text-fg2">
                    {entry.path}
                  </span>
                </button>
              ))}
            </div>
          )}
          {atOpen && atMatches.length === 0 && atMention && atMention.query.length > 0 && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-lg border border-line2 bg-raise px-3 py-2.5 text-[12.5px] text-mute shadow-[var(--shadow-float)]">
              {zh ? `未找到匹配 “${atMention.query}” 的文件` : `No files match “${atMention.query}”`}
            </div>
          )}

          <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="flex h-8 max-w-[220px] items-center gap-2 rounded-md bg-high px-2">
                  {attachment.kind === "image" && attachment.data ? (
                    <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-5 w-5 rounded object-cover" />
                  ) : (
                    <Icon name="file" size={10} className="text-dim" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-fg2" title={attachmentLabel(attachment)}>
                    {attachmentLabel(attachment)}
                  </span>
                  <button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-faint hover:text-fg" title={zh ? "移除" : "Remove"}>
                    <Icon name="x" size={8} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {dragOver && (
            <div className="pointer-events-none border-b border-acc/20 bg-acc/5 px-4 py-2 text-center text-[12px] text-acc">
              {zh ? "放下以添加文件路径" : "Drop to attach file paths"}
            </div>
          )}
          <textarea
            ref={taRef}
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setCursor(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
            onClick={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
            onKeyUp={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            rows={2}
            placeholder={zh ? "描述你的任务… · @ 引用文件 · 拖入路径" : "Describe a task… · @ files · drop paths"}
            disabled={auth.required}
            className="block min-h-[64px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <ProviderSwitcher />
            <ChipSelect label={<span className="text-fg2">{currentModel?.label ?? model}</span>} items={models.map((item) => ({ id: item.id, label: item.label, hint: item.tagline }))} activeId={model} onSelect={setModel} width={240} />
            <PromptOptionsMenu mode={mode} effort={effort} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={auth.required || readingFiles || attachments.length >= MAX_ATTACHMENTS}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] leading-none text-dim transition-colors hover:bg-high hover:text-fg2 disabled:opacity-40"
              title={zh ? "上传文件；可拖入路径、粘贴长文本为附件" : "Attach files; drag paths or paste long text as files"}
            >
              <Icon name="clip" size={12} />
              {readingFiles ? (zh ? "读取中" : "Reading") : (zh ? "附件" : "Attach")}
            </button>
            <div className="flex-1" />
            <button
              onClick={() => void launch()}
              disabled={(!q.trim() && attachments.length === 0) || auth.required || readingFiles}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${(q.trim() || attachments.length > 0) && !auth.required ? "bg-acc text-base hover:bg-acc-deep" : "bg-high text-faint"}`}
              title={zh ? "开始任务" : "Start"}
            >
              <Icon name="arrowUp" size={13} strokeWidth={2} />
            </button>
          </div>
          {attachmentError && <p className="border-t border-red/15 px-3 py-1.5 text-[12px] text-red">{attachmentError}</p>}
        </div>

        {recent.length > 0 && (
          <div className="mt-10 w-[min(560px,100%)]">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <span className="text-[12.5px] font-medium text-mute">{zh ? "最近任务" : "Recent"}</span>
              <span className="tnum text-[12px] text-faint">{recent.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recent.map((m) => {
                const tokens =
                  (sessions[m.id]?.usage.inputTokens ?? 0) + (sessions[m.id]?.usage.outputTokens ?? 0);
                return (
                  <button
                    key={m.id}
                    onClick={() => openSession(m.id)}
                    className="group rounded-lg border border-line2 bg-raise px-3.5 py-3 text-left transition-colors hover:bg-high"
                  >
                    <p className="truncate text-[13px] text-fg2 group-hover:text-fg">{m.title}</p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="text-[12px] text-faint">{fmtRelTime(m.updatedAt)}</span>
                      {tokens > 0 && (
                        <span className="tnum text-[11px] text-faint">{fmtTokens(tokens)}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex h-9 items-center justify-between px-5">
        <span className="max-w-[60%] truncate text-[12px] text-faint">{workspace}</span>
        <span className="text-[12px] text-faint">⌘K {zh ? "命令" : "Commands"} · ⌘N {t("newProject")}</span>
      </div>
    </div>
  );
}

function WorkspaceTabs({
  mode,
  onChange,
}: {
  mode: "conversation" | "image" | "video";
  onChange(mode: "conversation" | "image" | "video"): void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  return (
    <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-[6px] border border-line2 bg-panel/90 p-1 shadow-lg backdrop-blur">
      {(
        [
          ["conversation", zh ? "对话" : "CHAT"],
          ["image", zh ? "图片" : "IMAGE"],
          ["video", zh ? "视频" : "VIDEO"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex h-7 items-center gap-1.5 rounded-[4px] px-3 font-mono text-[9.5px] tracking-[0.08em] transition-colors ${
            mode === id ? "bg-acc text-base" : "text-dim hover:bg-high hover:text-fg2"
          }`}
        >
          {id === "conversation" ? (
            <Icon name="command" size={10} />
          ) : id === "image" ? (
            <Icon name="layers" size={10} />
          ) : (
            <Icon name="play" size={10} />
          )}
          {label}
        </button>
      ))}
    </div>
  );
}

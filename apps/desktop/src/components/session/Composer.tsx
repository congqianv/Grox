/* ─────────────────────────────────────────────────────────────────────────
   Composer — the uplink. One bordered instrument: text field on top,
   control strip below (mode · model · effort · attach · voice · send).
   Slash opens the command menu; @ searches project files; Enter transmits.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktop, type QueuedPrompt } from "../../state/store";
import {
  EFFORTS,
  type PromptAttachment,
  type WorkspaceEntry,
} from "../../bridge/types";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";
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
import { RewindMenu } from "./RewindMenu";

interface SlashCmd {
  id: string;
  hint: string;
  run: () => void;
}

/** Stable empty refs — `?? []` inside Zustand selectors re-renders forever. */
const EMPTY_QUEUE: QueuedPrompt[] = [];
const EMPTY_ATTACHMENTS: PromptAttachment[] = [];
const EMPTY_FILES: WorkspaceEntry[] = [];

function attachmentLabel(attachment: PromptAttachment): string {
  if (attachment.kind === "path" && attachment.path) return attachment.path;
  return attachment.name;
}

function attachmentMeta(attachment: PromptAttachment, zh: boolean): string {
  if (attachment.kind === "path") return zh ? "路径" : "path";
  if (attachment.size <= 0) return "";
  return attachment.size < 1024 * 1024
    ? `${Math.max(1, Math.round(attachment.size / 1024))} KB`
    : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [slashIdx, setSlashIdx] = useState(0);
  const [atIdx, setAtIdx] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();

  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const removeQueuedPrompt = useDesktop((s) => s.removeQueuedPrompt);
  const clearPromptQueue = useDesktop((s) => s.clearPromptQueue);
  const activeId = useDesktop((s) => s.activeId);
  const composer = useDesktop((s) => (s.activeId ? s.sessionComposers[s.activeId] : undefined));
  const queue = useDesktop((s) => {
    if (!s.activeId) return EMPTY_QUEUE;
    return s.promptQueues[s.activeId] ?? EMPTY_QUEUE;
  });
  const text = composer?.text ?? "";
  const attachments = composer?.attachments ?? EMPTY_ATTACHMENTS;
  const setText = useDesktop((s) => s.setDraft);
  const setAttachments = useDesktop((s) => s.setComposerAttachments);
  const stop = useDesktop((s) => s.stop);
  const compact = useDesktop((s) => s.compact);
  const status = useDesktop((s) => (s.activeId ? s.sessions[s.activeId]?.status : null));
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const effort = useDesktop((s) => s.effort);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const mode = useDesktop((s) => s.mode);
  const setModel = useDesktop((s) => s.setModel);
  const setEffort = useDesktop((s) => s.setEffort);
  const setPermissionMode = useDesktop((s) => s.setPermissionMode);
  const setMode = useDesktop((s) => s.setMode);
  const newProject = useDesktop((s) => s.newProject);
  const goHome = useDesktop((s) => s.goHome);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);
  const workspace = useDesktop((s) => s.workspace);
  const workspaceFiles = useDesktop((s) => s.workspaceFiles);
  const refreshWorkspaceFiles = useDesktop((s) => s.refreshWorkspaceFiles);

  const running =
    status === "running" || status === "awaiting_permission" || status === "awaiting_input";

  const slashCommands: SlashCmd[] = [
    { id: "/plan", hint: zh ? "计划模式 — 操作前先规划" : "plan mode — think before acting", run: () => setMode("plan") },
    { id: "/agent", hint: zh ? "Agent 模式 — 完整工具访问" : "agent mode — full tool access", run: () => setMode("agent") },
    { id: "/ask", hint: zh ? "问答模式 — 不编辑文件" : "ask mode — answers, no edits", run: () => setMode("ask") },
    {
      id: "/compact",
      hint: zh ? "压缩会话上下文" : "compress conversation context",
      run: compact,
    },
    { id: "/new", hint: zh ? "创建新项目" : "start a new project", run: () => void newProject() },
    { id: "/home", hint: zh ? "返回任务控制台" : "return to mission control", run: goHome },
    { id: "/settings", hint: zh ? "打开设置" : "open settings", run: () => setSettingsOpen(true) },
    {
      id: "/model",
      hint: "cycle model",
      run: () => {
        if (models.length === 0) return;
        const i = Math.max(0, models.findIndex((m) => m.id === model));
        setModel(models[(i + 1) % models.length].id);
      },
    },
    {
      id: "/effort",
      hint: "cycle reasoning effort",
      run: () => {
        const i = Math.max(0, EFFORTS.indexOf(effort));
        setEffort(EFFORTS[(i + 1) % EFFORTS.length]);
      },
    },
  ];

  const slashOpen = text.startsWith("/") && !text.includes(" ");
  const slashQuery = slashOpen ? text.slice(1).toLowerCase() : "";
  const slashMatches = slashOpen ? slashCommands.filter((c) => c.id.slice(1).startsWith(slashQuery)) : [];

  const atMention = useMemo(() => activeAtQuery(text, cursor), [text, cursor]);
  const atOpen = Boolean(atMention) && !slashOpen;
  const atMatches = useMemo(() => {
    if (!atOpen || !atMention) return EMPTY_FILES;
    return searchWorkspaceFiles(workspaceFiles, atMention.query);
  }, [atOpen, atMention, workspaceFiles]);

  useEffect(() => setSlashIdx(0), [slashQuery]);
  useEffect(() => setAtIdx(0), [atMention?.query, atOpen]);

  useEffect(() => {
    if (atOpen && workspaceFiles.length === 0) {
      void refreshWorkspaceFiles();
    }
  }, [atOpen, workspaceFiles.length, refreshWorkspaceFiles]);

  // auto-grow
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const applyText = (next: string, nextCursor?: number) => {
    setText(next);
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
      // Path chips only — bridge turns them into @mentions at send time.
      appendPrepared(paths.map((path) => preparePathAttachment(path, workspace)));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(attachmentErrorMessage(code, language));
    }
  };

  const pathDropRef = useRef(appendPathStrings);
  pathDropRef.current = appendPathStrings;

  // Tauri native drag-drop exposes real filesystem paths (HTML5 File.path is empty).
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
      for (const file of files) {
        prepared.push(await prepareDroppedFile(file, workspace));
      }
      appendPrepared(prepared);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(attachmentErrorMessage(code, language));
    } finally {
      setReadingFiles(false);
    }
  };

  const send = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || readingFiles) return;
    sendPrompt(t, attachments);
    setText("");
    setAttachments([]);
    setAttachmentError("");
    setCursor(0);
  };

  const pickAtFile = (entry: WorkspaceEntry) => {
    if (!atMention) return;
    const { text: next, cursor: nextCursor } = insertAtMention(
      text,
      atMention.start,
      cursor,
      entry.path,
    );
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

  const parseDroppedPaths = (raw: string): string[] => {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        if (line.startsWith("file://")) {
          try {
            const url = new URL(line);
            // macOS/Linux: pathname is absolute; Windows: /C:/...
            return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
          } catch {
            return line.replace(/^file:\/\//, "");
          }
        }
        return line;
      })
      .filter(Boolean);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    // Tauri native listener already received absolute paths.
    if (isNativeDragDropActive()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      void appendFiles(files);
      return;
    }
    // Fallback: some hosts only provide text/uri-list or plain path text.
    const uriList =
      event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (uriList.trim()) appendPathStrings(parseDroppedPaths(uriList));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME (e.g. Chinese Pinyin): Enter confirms the candidate, not "send".
    // Also ignore the post-compositionend Enter some WebViews still fire.
    if (isImeBlocking(e)) return;

    if (atOpen && atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickAtFile(atMatches[Math.min(atIdx, atMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Close picker by inserting a space after @query (or just leave)
        applyText(text, cursor);
        return;
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        slashMatches[Math.min(slashIdx, slashMatches.length - 1)].run();
        setText("");
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const currentModel = models.find((m) => m.id === model);

  return (
    <div className="relative z-30 shrink-0 px-6 pb-5 pt-2">
      <div className="relative mx-auto max-w-[760px]">
        {slashOpen && slashMatches.length > 0 && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-lg border border-line2 bg-raise py-1 shadow-[var(--shadow-float)] animate-fade-up">
            {slashMatches.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  c.run();
                  setText("");
                }}
                className={`flex w-full items-center gap-3 px-3 py-1.5 text-left ${
                  i === slashIdx ? "bg-high" : "hover:bg-high/60"
                }`}
              >
                <span className="w-20 shrink-0 font-mono text-[12px] leading-none text-acc">{c.id}</span>
                <span className="text-[12.5px] leading-none text-mute">{c.hint}</span>
              </button>
            ))}
          </div>
        )}

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

        {queue.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-lg border border-line2 bg-raise">
            <div className="flex h-8 items-center justify-between border-b border-line px-3">
              <span className="text-[12px] font-medium text-mute">
                {zh ? `队列 ${queue.length}` : `Queued ${queue.length}`}
              </span>
              <button
                onClick={() => activeId && clearPromptQueue(activeId)}
                className="text-[11.5px] text-faint transition-colors hover:text-fg"
              >
                {zh ? "清空" : "Clear"}
              </button>
            </div>
            <div className="max-h-28 overflow-y-auto py-1">
              {queue.map((item, index) => (
                <div key={item.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="tnum w-4 shrink-0 text-[11px] text-faint">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">
                    {item.text || item.attachments.map((a) => attachmentLabel(a)).join(", ")}
                  </span>
                  {item.attachments.length > 0 && (
                    <span className="shrink-0 text-[11px] text-faint">{item.attachments.length}</span>
                  )}
                  <button
                    onClick={() => activeId && removeQueuedPrompt(activeId, item.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-high hover:text-fg"
                    title={zh ? "移除" : "Remove"}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* overflow-visible: chip/options menus open below the toolbar and must not be clipped */}
        <div
          className={`surface overflow-visible transition-shadow ${
            dragOver ? "ring-1 ring-acc/50 shadow-[0_0_0_1px_var(--color-acc)]" : ""
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
          onDrop={onDrop}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void appendFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="group flex h-8 max-w-[280px] items-center gap-2 rounded-md bg-high pl-1.5 pr-1">
                  {attachment.kind === "image" && attachment.data ? (
                    <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-5 w-5 rounded object-cover" />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-raise text-dim">
                      <Icon name="file" size={11} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] leading-none text-fg2" title={attachmentLabel(attachment)}>
                      {attachmentLabel(attachment)}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-none text-faint">
                      {attachmentMeta(attachment, zh)}
                    </p>
                  </div>
                  <button
                    onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-raise hover:text-fg"
                    title={zh ? "移除附件" : "Remove attachment"}
                  >
                    <Icon name="x" size={9} />
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
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onPaste={onPaste}
            rows={1}
            placeholder={
              running
                ? (zh ? "Grok 正在处理 — 回车加入队列…" : "Grok is working — Enter to queue…")
                : (zh ? "发送给 Grok… · @ 引用文件 · 拖入路径" : "Message Grok… · @ files · drop paths")
            }
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <ProviderSwitcher />

            <ChipSelect
              label={
                <span className="text-fg2">{currentModel?.label ?? model}</span>
              }
              items={models.map((m) => ({ id: m.id, label: m.label, hint: m.tagline }))}
              activeId={model}
              onSelect={setModel}
              width={240}
            />

            <PromptOptionsMenu mode={mode} effort={effort} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />

            <button
              onClick={() => fileRef.current?.click()}
              disabled={readingFiles || attachments.length >= MAX_ATTACHMENTS}
              title={zh ? "上传文件；可拖入路径、粘贴长文本为附件" : "Upload files; drag paths or paste long text as files"}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] leading-none text-dim transition-colors hover:bg-high hover:text-fg2 disabled:opacity-40"
            >
              <Icon name="clip" size={12} />
              {readingFiles ? (zh ? "读取中" : "Reading") : (zh ? "附件" : "Attach")}
            </button>

            <div className="flex-1" />

            {!running && (
              <RewindMenu onComplete={() => taRef.current?.focus()} />
            )}

            {running && (
              <button
                onClick={stop}
                title={zh ? "停止" : "Stop"}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-red/30 text-red transition-colors hover:bg-red/10"
              >
                <Icon name="stop" size={11} />
              </button>
            )}

            <button
              onClick={send}
              disabled={(!text.trim() && attachments.length === 0) || readingFiles}
              title={running ? (zh ? "加入队列" : "Queue") : (zh ? "发送" : "Send")}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                text.trim() || attachments.length > 0
                  ? "bg-acc text-base hover:bg-acc-deep"
                  : "bg-high text-faint"
              }`}
            >
              <Icon name="arrowUp" size={13} strokeWidth={2} />
            </button>
          </div>
          {attachmentError && <p className="border-t border-red/15 px-3 py-1.5 text-[12px] text-red">{attachmentError}</p>}
        </div>

        <div className="mt-2 flex items-center justify-between px-1.5">
          <span className="text-[11.5px] text-faint">
            {zh
              ? running
                ? "⏎ 加入队列 · ⇧⏎ 换行 · 粘贴长文→文件 · @ 文件 · / 命令"
                : "⏎ 发送 · ⇧⏎ 换行 · 粘贴长文→文件 · @ 文件 · / 命令"
              : running
                ? "⏎ queue · ⇧⏎ newline · long paste→file · @ files · / commands"
                : "⏎ send · ⇧⏎ newline · long paste→file · @ files · / commands"}
          </span>
          <span className="text-[11.5px] text-faint">
            {zh
              ? mode === "plan" ? "计划模式 · 批准前只读" : mode === "ask" ? "问答模式 · 不使用工具" : "Agent 模式 · 完整工具权限"
              : mode === "plan" ? "Plan · read-only until approved" : mode === "ask" ? "Ask · no tools" : "Agent · full tool access"}
          </span>
        </div>
      </div>
    </div>
  );
}

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
import { attachExplicitPromptImages } from "../../lib/pathAttachments";
import {
  elementContainsPoint,
  isNativeDragDropActive,
  listenNativeFileDrop,
  pathsFromDataTransfer,
} from "../../lib/dragDrop";
import { useImeGuard } from "../../lib/ime";
import { Markdown } from "../../lib/markdown";
import { looksLikeMarkdown } from "../../lib/markdownInput";
import { ActiveProcessBar } from "./ActiveProcessBar";
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
  const [composerFocused, setComposerFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();

  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const interjectPrompt = useDesktop((s) => s.interjectPrompt);
  const removeQueuedPrompt = useDesktop((s) => s.removeQueuedPrompt);
  const reorderQueuedPrompt = useDesktop((s) => s.reorderQueuedPrompt);
  const clearPromptQueue = useDesktop((s) => s.clearPromptQueue);
  const interjectQueuedPrompt = useDesktop((s) => s.interjectQueuedPrompt);
  const editQueuedPrompt = useDesktop((s) => s.editQueuedPrompt);
  const queueNotice = useDesktop((s) => s.queueNotice);
  const dismissQueueNotice = useDesktop((s) => s.dismissQueueNotice);
  const [queueDragIndex, setQueueDragIndex] = useState<number | null>(null);
  const [queueDropIndex, setQueueDropIndex] = useState<number | null>(null);
  const [interjecting, setInterjecting] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
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

  /** Turn is in flight — Enter queues, Ctrl+Enter interjects. */
  const busy = status === "running";
  /** Plan / permission / question gate — typing allowed, submit blocked with reason. */
  const gated = status === "awaiting_permission" || status === "awaiting_input";
  const running = busy || gated;
  const hasPendingPlan = Boolean(
    session &&
      status === "awaiting_permission" &&
      session.blocks.some(
        (block) =>
          block.type === "permission" && !block.resolved && block.id.startsWith("plan-approval-"),
      ),
  );
  const hasPendingPermission = status === "awaiting_permission" && !hasPendingPlan;
  const hasPendingQuestion = status === "awaiting_input";
  const canSubmit = Boolean(text.trim() || attachments.length > 0) && !readingFiles && !interjecting;

  const submitBlockReason = useMemo(() => {
    if (!gated) return "";
    if (hasPendingQuestion) return zh ? "请先回答当前问题再发送" : "Answer the open question before sending";
    if (hasPendingPlan) return zh ? "请先批准或拒绝当前计划再发送" : "Approve or reject the plan before sending";
    if (hasPendingPermission) return zh ? "请先处理当前权限请求再发送" : "Resolve the permission request before sending";
    return zh ? "请先处理当前交互再发送" : "Resolve the pending interaction before sending";
  }, [gated, hasPendingQuestion, hasPendingPlan, hasPendingPermission, zh]);

  // Auto-dismiss queue receipts after a few seconds.
  useEffect(() => {
    if (!queueNotice) return;
    const timer = window.setTimeout(() => dismissQueueNotice(), 4200);
    return () => window.clearTimeout(timer);
  }, [queueNotice, dismissQueueNotice]);

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

  const markdownDraft = looksLikeMarkdown(text);
  // While focused, always edit raw source; when blurred and markdown is present, show only the render.
  const showMarkdownRender = markdownDraft && !composerFocused;

  // auto-grow
  useEffect(() => {
    const el = taRef.current;
    if (!el || showMarkdownRender) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text, showMarkdownRender]);

  // After switching from rendered view back to the textarea, restore focus.
  useEffect(() => {
    if (showMarkdownRender || !composerFocused) return;
    const el = taRef.current;
    if (!el || document.activeElement === el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCursor(end);
  }, [showMarkdownRender, composerFocused]);

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
  // Only accept when the pointer is over the composer surface — sidebar drops import projects.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listenNativeFileDrop((event) => {
      const overComposer = elementContainsPoint(surfaceRef.current, event.position);
      if (event.phase === "enter" || event.phase === "over") {
        setDragOver(overComposer);
        return;
      }
      if (event.phase === "leave") {
        setDragOver(false);
        return;
      }
      if (event.phase === "drop") {
        setDragOver(false);
        if (!overComposer || event.paths.length === 0) return;
        pathDropRef.current(event.paths);
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

  const clearComposer = () => {
    setText("");
    setAttachments([]);
    setAttachmentError("");
    setCursor(0);
  };

  const sendInFlight = useRef(false);

  const send = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || readingFiles || interjecting || sendInFlight.current)
      return;
    void (async () => {
      sendInFlight.current = true;
      setAttachmentError("");
      try {
        const turnAttachments = await attachExplicitPromptImages(workspace, t, attachments);
        // Keep the draft when gated — sendPrompt only posts a notice.
        if (gated) {
          sendPrompt(t, turnAttachments);
          return;
        }
        sendPrompt(t, turnAttachments);
        clearComposer();
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : String(cause);
        setAttachmentError(attachmentErrorMessage(code, language));
      } finally {
        sendInFlight.current = false;
      }
    })();
  };

  const interject = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || readingFiles || interjecting || sendInFlight.current)
      return;
    void (async () => {
      sendInFlight.current = true;
      setAttachmentError("");
      try {
        const turnAttachments = await attachExplicitPromptImages(workspace, t, attachments);
        if (gated) {
          sendPrompt(t, turnAttachments);
          return;
        }
        if (!busy) {
          sendPrompt(t, turnAttachments);
          clearComposer();
          return;
        }
        setInterjecting(true);
        try {
          const accepted = await interjectPrompt(t, turnAttachments);
          if (accepted) clearComposer();
        } finally {
          setInterjecting(false);
        }
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : String(cause);
        setAttachmentError(attachmentErrorMessage(code, language));
      } finally {
        sendInFlight.current = false;
      }
    })();
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
    const paths = pathsFromDataTransfer(event.dataTransfer);
    if (paths.length > 0) appendPathStrings(paths);
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

    // Ctrl+Enter → same-turn interject while busy; plain send when idle.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      interject();
      return;
    }

    // Enter → send / queue / blocked notice. Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const currentModel = models.find((m) => m.id === model);

  return (
    <div className="relative z-30 shrink-0 px-6 pb-5 pt-2">
      <div className="relative mx-auto max-w-[760px]">
        <ActiveProcessBar session={session} zh={zh} />

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

        {(queueNotice || queue.length > 0) && (
          <div className="mb-2 overflow-hidden rounded-lg border border-line2 bg-raise">
            {queueNotice && (
              <div
                role="status"
                className={`flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-[12px] ${
                  queueNotice.state === "blocked" || queueNotice.state === "duplicate"
                    ? "bg-gold/10 text-gold"
                    : queueNotice.state === "interjected"
                      ? "bg-acc/10 text-acc"
                      : "text-mute"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{queueNotice.message}</span>
                <button
                  type="button"
                  onClick={dismissQueueNotice}
                  className="shrink-0 text-faint hover:text-fg"
                  title={zh ? "关闭" : "Dismiss"}
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            )}
            {queue.length > 0 && (
              <>
                <div className="flex h-8 items-center justify-between border-b border-line px-3">
                  <span className="text-[12px] font-medium text-mute">
                    {zh ? `队列 ${queue.length}` : `Queued ${queue.length}`}
                  </span>
                  <div className="flex items-center gap-2">
                    {queue.length > 1 && (
                      <span className="text-[11px] text-faint">
                        {zh ? "拖拽或箭头调整顺序" : "Drag or arrows to reorder"}
                      </span>
                    )}
                    <button
                      onClick={() => activeId && clearPromptQueue(activeId)}
                      className="text-[11.5px] text-faint transition-colors hover:text-fg"
                    >
                      {zh ? "清空" : "Clear"}
                    </button>
                  </div>
                </div>
                <div
                  className="max-h-40 overflow-y-auto py-1"
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setQueueDropIndex(null);
                    }
                  }}
                >
                  {queue.map((item, index) => {
                    const canMoveUp = index > 0;
                    const canMoveDown = index < queue.length - 1;
                    const isDragging = queueDragIndex === index;
                    const isDropTarget =
                      queueDropIndex === index && queueDragIndex !== null && queueDragIndex !== index;
                    const stateLabel =
                      item.state === "interjected"
                        ? zh
                          ? "插话优先"
                          : "Interject"
                        : item.state === "sending"
                          ? zh
                            ? "发送中"
                            : "Sending"
                          : zh
                            ? "已入队"
                            : "Queued";
                    return (
                      <div
                        key={item.id}
                        draggable={queue.length > 1 && item.state === "queued"}
                        onDragStart={(event) => {
                          if (queue.length <= 1 || item.state !== "queued") return;
                          setQueueDragIndex(index);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", String(index));
                          if (event.currentTarget instanceof HTMLElement) {
                            event.currentTarget.style.opacity = "0.55";
                          }
                        }}
                        onDragEnd={(event) => {
                          if (event.currentTarget instanceof HTMLElement) {
                            event.currentTarget.style.opacity = "";
                          }
                          setQueueDragIndex(null);
                          setQueueDropIndex(null);
                        }}
                        onDragOver={(event) => {
                          if (queueDragIndex === null || queueDragIndex === index) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          if (queueDropIndex !== index) setQueueDropIndex(index);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const from =
                            queueDragIndex ??
                            Number.parseInt(event.dataTransfer.getData("text/plain"), 10);
                          if (
                            activeId &&
                            Number.isFinite(from) &&
                            from !== index &&
                            from >= 0 &&
                            from < queue.length
                          ) {
                            reorderQueuedPrompt(activeId, from, index);
                          }
                          setQueueDragIndex(null);
                          setQueueDropIndex(null);
                        }}
                        className={`flex items-center gap-1.5 px-2 py-1.5 transition-colors ${
                          isDragging
                            ? "bg-high/40"
                            : isDropTarget
                              ? "bg-acc/10"
                              : item.state === "interjected"
                                ? "bg-acc/5"
                                : "hover:bg-high/40"
                        } ${queue.length > 1 && item.state === "queued" ? "cursor-grab active:cursor-grabbing" : ""}`}
                      >
                        {queue.length > 1 && (
                          <span
                            className="flex h-6 w-4 shrink-0 items-center justify-center text-faint"
                            title={zh ? "拖拽调整顺序" : "Drag to reorder"}
                            aria-hidden
                          >
                            <Icon name="grip" size={10} />
                          </span>
                        )}
                        <span className="tnum w-4 shrink-0 text-center text-[11px] text-faint">
                          {index + 1}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px] ${
                            item.state === "interjected"
                              ? "bg-acc/15 text-acc"
                              : item.state === "sending"
                                ? "bg-gold/15 text-gold"
                                : "bg-high text-faint"
                          }`}
                        >
                          {stateLabel}
                        </span>
                        {editingQueueId === item.id ? (
                          <input
                            autoFocus
                            value={editingQueueText}
                            onChange={(event) => setEditingQueueText(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setEditingQueueId(null);
                                return;
                              }
                              if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                if (activeId && editingQueueText.trim()) {
                                  editQueuedPrompt(activeId, item.id, editingQueueText);
                                }
                                setEditingQueueId(null);
                              }
                            }}
                            onBlur={() => {
                              if (activeId && editingQueueText.trim() && editingQueueText.trim() !== item.text) {
                                editQueuedPrompt(activeId, item.id, editingQueueText);
                              }
                              setEditingQueueId(null);
                            }}
                            className="min-w-0 flex-1 rounded border border-acc/40 bg-void px-2 py-0.5 text-[12.5px] text-fg outline-none"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">
                            {item.text || item.attachments.map((a) => attachmentLabel(a)).join(", ")}
                          </span>
                        )}
                        {item.attachments.length > 0 && editingQueueId !== item.id && (
                          <span className="shrink-0 text-[11px] text-faint">
                            {item.attachments.length}
                          </span>
                        )}
                        {item.state === "queued" && activeId && editingQueueId !== item.id && (
                          <>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingQueueId(item.id);
                                setEditingQueueText(item.text);
                              }}
                              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-mute hover:bg-high hover:text-fg"
                              title={zh ? "编辑" : "Edit"}
                            >
                              {zh ? "编辑" : "Edit"}
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                interjectQueuedPrompt(activeId, item.id);
                              }}
                              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-acc hover:bg-acc/10"
                              title={zh ? "置顶优先发送" : "Promote to front"}
                            >
                              {zh ? "插话" : "Bump"}
                            </button>
                          </>
                        )}
                        {queue.length > 1 && item.state === "queued" && (
                          <div className="flex shrink-0 items-center">
                            <button
                              type="button"
                              disabled={!canMoveUp || !activeId}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (activeId && canMoveUp) {
                                  reorderQueuedPrompt(activeId, index, index - 1);
                                }
                              }}
                              className="flex h-6 w-5 items-center justify-center rounded-md text-faint transition-colors hover:bg-high hover:text-fg disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-faint"
                              title={zh ? "上移" : "Move up"}
                              aria-label={zh ? "上移" : "Move up"}
                            >
                              <Icon name="chevronUp" size={11} />
                            </button>
                            <button
                              type="button"
                              disabled={!canMoveDown || !activeId}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (activeId && canMoveDown) {
                                  reorderQueuedPrompt(activeId, index, index + 1);
                                }
                              }}
                              className="flex h-6 w-5 items-center justify-center rounded-md text-faint transition-colors hover:bg-high hover:text-fg disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-faint"
                              title={zh ? "下移" : "Move down"}
                              aria-label={zh ? "下移" : "Move down"}
                            >
                              <Icon name="chevronDown" size={11} />
                            </button>
                          </div>
                        )}
                        <button
                          type="button"
                          disabled={item.state !== "queued"}
                          onClick={() =>
                            activeId && item.state === "queued" && removeQueuedPrompt(activeId, item.id)
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-high hover:text-fg disabled:opacity-25"
                          title={zh ? "移除" : "Remove"}
                        >
                          <Icon name="x" size={10} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* overflow-visible: chip/options menus open below the toolbar and must not be clipped */}
        <div
          ref={surfaceRef}
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

          {showMarkdownRender ? (
            <button
              type="button"
              className="block w-full max-h-[180px] min-h-[44px] overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-left focus:outline-none"
              title={zh ? "点击继续编辑" : "Click to edit"}
              onClick={() => setComposerFocused(true)}
            >
              <Markdown text={text} className="composer-md text-[14.5px] leading-relaxed text-fg" />
            </button>
          ) : (
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
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              rows={1}
              placeholder={
                gated
                  ? submitBlockReason ||
                    (zh ? "可以继续输入；请先处理当前交互再发送…" : "Keep typing; resolve the open interaction first…")
                  : busy
                    ? zh
                      ? "继续输入；Enter 排队，Ctrl+Enter 插话…"
                      : "Keep typing; Enter queues, Ctrl+Enter interjects…"
                    : zh
                      ? "发送给 Grok… · @ 引用文件 · 拖入路径"
                      : "Message Grok… · @ files · drop paths"
              }
              className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
            />
          )}

          {gated && submitBlockReason && (
            <div className="border-t border-gold/20 bg-gold/5 px-3 py-1.5 text-[12px] text-gold">
              {submitBlockReason}
            </div>
          )}

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

            {busy && (
              <>
                <button
                  type="button"
                  onClick={send}
                  disabled={!canSubmit}
                  title={zh ? "加入队列 (Enter)" : "Queue (Enter)"}
                  className="flex h-7 items-center gap-1 rounded-md border border-line2 px-2.5 text-[11.5px] text-fg2 transition-colors hover:bg-high disabled:opacity-40"
                >
                  {zh ? "加入队列" : "Queue"}
                </button>
                <button
                  type="button"
                  onClick={interject}
                  disabled={!canSubmit}
                  title={zh ? "插入当前回合 (Ctrl+Enter)" : "Interject current turn (Ctrl+Enter)"}
                  className="flex h-7 items-center gap-1 rounded-md border border-acc/40 bg-acc/10 px-2.5 text-[11.5px] text-acc transition-colors hover:bg-acc/15 disabled:opacity-40"
                >
                  {interjecting ? (zh ? "插话中…" : "Interjecting…") : zh ? "插话" : "Interject"}
                </button>
              </>
            )}

            {!busy && (
              <button
                onClick={send}
                disabled={!canSubmit || gated}
                title={
                  gated
                    ? submitBlockReason
                    : zh
                      ? "发送"
                      : "Send"
                }
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  canSubmit && !gated
                    ? "bg-acc text-base hover:bg-acc-deep"
                    : "bg-high text-faint"
                }`}
              >
                <Icon name="arrowUp" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {attachmentError && <p className="border-t border-red/15 px-3 py-1.5 text-[12px] text-red">{attachmentError}</p>}
        </div>

        <div className="mt-2 flex items-center justify-between px-1.5">
          <span className="text-[11.5px] text-faint">
            {zh
              ? gated
                ? "可继续输入 · 先处理计划/权限/问题 · ⇧⏎ 换行"
                : busy
                  ? "⏎ 加入队列 · ⌃⏎ 插话 · ⇧⏎ 换行 · @ 文件 · / 命令"
                  : "⏎ 发送 · ⇧⏎ 换行 · @ 文件 · / 命令"
              : gated
                ? "Keep typing · resolve plan/permission/question first · ⇧⏎ newline"
                : busy
                  ? "⏎ queue · ⌃⏎ interject · ⇧⏎ newline · @ files · / commands"
                  : "⏎ send · ⇧⏎ newline · @ files · / commands"}
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

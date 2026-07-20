/* ─────────────────────────────────────────────────────────────────────────
   Home — mission control. Deep field, the orbital mark, one input, and
   the last few missions. Everything else is silence.
   ───────────────────────────────────────────────────────────────────────── */

import { useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import type { PromptAttachment } from "../../bridge/types";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { BlackHole } from "../fx/BlackHole";
import { Starfield } from "../fx/Starfield";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { useI18n } from "../../lib/i18n";

export function Home() {
  const { language, t } = useI18n();
  const [q, setQ] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const workspace = useDesktop((s) => s.workspace);
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

  const launch = async () => {
    const prompt = q.trim();
    if ((!prompt && attachments.length === 0) || readingFiles) return;
    await newSession();
    sendPrompt(prompt, attachments);
    setQ("");
    setAttachments([]);
    setAttachmentError("");
  };

  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const prepared: PromptAttachment[] = [];
      for (const file of files) prepared.push(await prepareAttachment(file));
      const next = [...attachments, ...prepared];
      validateAttachmentSet(next);
      setAttachments(next);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(code === "attachment_count"
        ? (language === "zh-CN" ? "每次最多上传 8 个附件" : "Up to 8 attachments per prompt")
        : code === "attachment_size"
          ? (language === "zh-CN" ? "附件总大小不能超过 32 MB" : "Attachments cannot exceed 32 MB in total")
          : language === "zh-CN" ? code.replace(" exceeds 16 MB", " 超过 16 MB") : code);
    } finally {
      setReadingFiles(false);
    }
  };

  const currentModel = models.find((item) => item.id === model);

  return (
    <div className="relative flex-1 overflow-hidden bg-base">
      <Starfield />

      <div className="relative flex h-full flex-col items-center justify-center px-8 pb-16">
        <BlackHole size={88} spin="slow" />

        <h1 className="mt-6 font-sans text-[32px] font-semibold tracking-tight text-fg">
          Grox
        </h1>
        <p className="mt-2 text-[14px] text-mute">
          {language === "zh-CN" ? "今天想构建什么？" : "What are we building today?"}
        </p>

        {startupError && (
          <div className="mt-6 w-[min(560px,100%)] rounded-lg border border-red/20 bg-red/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-red">{language === "zh-CN" ? "连接失败" : "Connection failed"}</p>
                <p className="mt-1 break-words text-[12.5px] leading-relaxed text-fg2">
                  {startupError}
                </p>
                <p className="mt-1.5 text-[12px] text-dim">
                  {language === "zh-CN" ? "请安装 Grok CLI，或设置 GROK_DESKTOP_CLI 后重启 Grox。" : "Install Grok CLI or set GROK_DESKTOP_CLI, then restart Grox."}
                </p>
              </div>
            </div>
          </div>
        )}

        {auth.required && (
          <div className="mt-6 flex w-[min(560px,100%)] items-center gap-4 rounded-lg border border-gold/20 bg-gold/5 px-4 py-3">
            <BlackHole size={24} spin={auth.inProgress} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-gold">{language === "zh-CN" ? "需要账户设置" : "Sign in required"}</p>
              <p className="mt-1 text-[12.5px] text-fg2">
                {auth.error ?? (language === "zh-CN" ? "请先选择 OAuth、官方 API 或 OpenAI 兼容服务。" : "Connect your xAI account before starting.")}
              </p>
            </div>
            <button
              onClick={() => setAccountSetupOpen(true)}
              disabled={auth.inProgress}
              className="flex h-8 shrink-0 items-center rounded-md bg-acc px-3.5 text-[12.5px] font-medium leading-none text-base transition-colors hover:bg-acc-deep disabled:opacity-50"
            >
              {auth.inProgress ? (language === "zh-CN" ? "连接中" : "Connecting") : t("account")}
            </button>
          </div>
        )}

        {/* main prompt — floating composer */}
        <div className="surface mt-8 w-[min(680px,100%)] overflow-visible transition-shadow">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="flex h-8 max-w-[190px] items-center gap-2 rounded-md bg-high px-2">
                  {attachment.kind === "image" && attachment.data ? (
                    <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-5 w-5 rounded object-cover" />
                  ) : (
                    <Icon name="file" size={10} className="text-dim" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-fg2">{attachment.name}</span>
                  <button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-faint hover:text-fg" title={language === "zh-CN" ? "移除" : "Remove"}>
                    <Icon name="x" size={8} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
              if (images.length > 0) { event.preventDefault(); void appendFiles(images); }
            }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void launch(); } }}
            rows={2}
            placeholder={language === "zh-CN" ? "描述你的任务，或粘贴截图…" : "Describe a task, or paste a screenshot…"}
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
              title={language === "zh-CN" ? "上传文件；也支持粘贴剪贴板图片" : "Attach files; clipboard images are also supported"}
            >
              <Icon name="clip" size={12} />
              {readingFiles ? (language === "zh-CN" ? "读取中" : "Reading") : (language === "zh-CN" ? "附件" : "Attach")}
            </button>
            <div className="flex-1" />
            <button
              onClick={() => void launch()}
              disabled={(!q.trim() && attachments.length === 0) || auth.required || readingFiles}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${(q.trim() || attachments.length > 0) && !auth.required ? "bg-acc text-base hover:bg-acc-deep" : "bg-high text-faint"}`}
              title={language === "zh-CN" ? "开始任务" : "Start"}
            >
              <Icon name="arrowUp" size={13} strokeWidth={2} />
            </button>
          </div>
          {attachmentError && <p className="border-t border-red/15 px-3 py-1.5 text-[12px] text-red">{attachmentError}</p>}
        </div>

        {recent.length > 0 && (
          <div className="mt-10 w-[min(560px,100%)]">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <span className="text-[12.5px] font-medium text-mute">{language === "zh-CN" ? "最近任务" : "Recent"}</span>
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
        <span className="text-[12px] text-faint">⌘K {language === "zh-CN" ? "命令" : "Commands"} · ⌘N {t("newProject")}</span>
      </div>
    </div>
  );
}

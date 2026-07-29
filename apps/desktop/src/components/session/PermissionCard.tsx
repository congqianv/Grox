/* ─────────────────────────────────────────────────────────────────────────
   PermissionCard — the moment the agent asks the operator.
   Bright-bordered, gold-headed, keyboard-first (1 / 2 / 3). Resolves in
   place and quiets down into the transcript.
   Plan decisions are locked on first click (sessionId + requestId).
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import type { PermissionOption, SessionBlock } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

type PermissionBlock = Extract<SessionBlock, { type: "permission" }>;

export function PermissionCard({ block, sessionId }: { block: PermissionBlock; sessionId: string }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const resolvePermission = useDesktop((s) => s.resolvePermission);
  const isActive = useDesktop(
    (s) => s.activeId === sessionId && s.sessions[sessionId]?.status === "awaiting_permission",
  );
  const resolved = block.resolved;
  const isPlan = block.id.startsWith("plan-approval-");
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const order: PermissionOption[] = ["allow_once", "allow_always", "deny"];
  const options = order.filter((o) => block.req.options.includes(o));
  const optionLabels: Record<PermissionOption, string> = {
    allow_once: isPlan
      ? zh
        ? "批准执行"
        : "Approve plan"
      : zh
        ? "仅本次允许"
        : "Allow once",
    allow_always: zh ? "始终允许" : "Always allow",
    deny: isPlan ? (zh ? "拒绝 / 继续规划" : "Reject / replan") : zh ? "拒绝" : "Deny",
  };

  const decide = (option: PermissionOption) => {
    if (resolved || locked.current || submitting) return;
    locked.current = true;
    setSubmitting(true);
    resolvePermission(block.id, option);
  };

  const optionKey = options.join(",");
  useEffect(() => {
    if (resolved || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const idx = ["1", "2", "3"].indexOf(e.key);
      if (idx >= 0 && options[idx]) {
        e.preventDefault();
        decide(options[idx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // optionKey is a stable string form of `options` (rebuilt each render).
  }, [resolved, isActive, optionKey, block.id, resolvePermission, submitting]);

  useEffect(() => {
    if (resolved) {
      locked.current = true;
      setSubmitting(false);
    }
  }, [resolved]);

  return (
    <div
      className={`mb-5 animate-fade-up rounded-lg border p-4 transition-opacity ${
        resolved ? "border-line2 bg-raise opacity-60" : "border-gold/30 bg-raise"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon name="bolt" size={13} className={resolved ? "text-dim" : "text-gold"} />
        <span className={`text-[12.5px] font-medium ${resolved ? "text-mute" : "text-gold"}`}>
          {resolved
            ? resolved === "deny"
              ? isPlan
                ? zh
                  ? "计划已拒绝"
                  : "Plan rejected"
                : zh
                  ? "已由用户拒绝"
                  : "Denied"
              : isPlan
                ? zh
                  ? "计划已批准 · 原回合继续"
                  : "Plan approved · turn continues"
                : zh
                  ? `已批准 · ${resolved === "allow_always" ? "始终" : "本次"}`
                  : `Approved · ${resolved === "allow_always" ? "always" : "once"}`
            : isPlan
              ? zh
                ? "计划待批准"
                : "Plan approval required"
              : zh
                ? "需要批准"
                : "Approval required"}
        </span>
        {!resolved && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-gold" />}
      </div>

      <p className="mt-2 text-[13px] text-fg2">
        {isPlan && !resolved
          ? zh
            ? "批准后直接继续原回合，不会额外发送「计划已批准」消息。"
            : "Approval answers the original plan request — no synthetic follow-up message."
          : block.req.description}
      </p>

      {block.req.payload && (
        <div className="mt-2.5 rounded-xl border border-line2 bg-void px-3.5 py-2.5">
          <code className="font-mono text-[12px] text-fg2 select-text">{block.req.payload}</code>
        </div>
      )}

      {!resolved && (
        <div className="mt-3.5 flex items-center gap-2">
          {options.map((opt, i) => {
            const styles =
              opt === "allow_once"
                ? "bg-acc text-base hover:bg-acc-deep font-medium"
                : opt === "allow_always"
                  ? "border border-line3 text-fg2 hover:bg-high"
                  : "border border-line2 text-mute hover:border-red hover:text-red";
            return (
              <button
                key={opt}
                disabled={submitting}
                onClick={() => decide(opt)}
                className={`flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] leading-none transition-colors disabled:opacity-50 ${styles}`}
              >
                {optionLabels[opt]}
                <kbd
                  className={`text-[11px] ${opt === "allow_once" ? "text-base/70" : "text-faint"}`}
                >
                  {i + 1}
                </kbd>
              </button>
            );
          })}
        </div>
      )}

      {resolved && isPlan && (
        <p className="mt-2 text-[11.5px] text-faint">
          {zh ? "重复点击不会再次提交决策。" : "Duplicate clicks will not re-submit this decision."}
        </p>
      )}
    </div>
  );
}

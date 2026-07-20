/* ─────────────────────────────────────────────────────────────────────────
   StatusBar — the telemetry strip. Spacecraft instrument readouts for the
   active mission: link state, context burn, token flow, cost, model.
   ───────────────────────────────────────────────────────────────────────── */

import { useDesktop } from "../../state/store";
import { fmtCost, fmtTokens } from "../../lib/format";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

export function StatusBar() {
  const { language } = useI18n();
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const model = useDesktop((s) => s.model);
  const effort = useDesktop((s) => s.effort);

  const status = session?.status ?? "idle";
  const usage = session?.usage;
  const ctxPct =
    usage && usage.contextMax > 0
      ? Math.min(100, Math.round((usage.contextUsed / usage.contextMax) * 100))
      : 0;

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[11.5px] leading-none text-dim select-none">
      <div className="flex items-center gap-2">
        <BlackHole size={12} spin={status === "running"} />
        <span
          className={
            status === "running"
              ? "font-medium leading-none text-fg2"
              : status === "awaiting_permission"
                ? "font-medium leading-none text-gold"
                : "leading-none text-mute"
          }
        >
          {language === "zh-CN"
            ? status === "running" ? "处理中" : status === "awaiting_permission" ? "等待批准" : status === "awaiting_input" ? "等待输入" : "就绪"
            : status === "running" ? "Working" : status === "awaiting_permission" ? "Awaiting approval" : status === "awaiting_input" ? "Awaiting input" : "Ready"}
        </span>
        {activeId && (
          <>
            <Sep />
            <span className="tnum text-faint">{activeId.slice(0, 8)}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        {usage && usage.contextUsed > 0 && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="text-faint">{language === "zh-CN" ? "上下文" : "Context"}</span>
              <span className="relative h-1 w-14 overflow-hidden rounded-full bg-high">
                <span
                  className={`absolute inset-y-0 left-0 rounded-full ${ctxPct > 80 ? "bg-gold" : "bg-acc"}`}
                  style={{ width: `${ctxPct}%` }}
                />
              </span>
              <span className={`tnum ${ctxPct > 80 ? "text-gold" : "text-fg2"}`}>{ctxPct}%</span>
            </span>
            <Sep />
            <span className="tnum text-mute">
              <span className="text-faint">↑</span> {fmtTokens(usage.inputTokens)}
              <span className="text-faint"> ↓</span> {fmtTokens(usage.outputTokens)}
            </span>
            <Sep />
            <span className="tnum text-fg2">{fmtCost(usage.costUSD)}</span>
            <Sep />
          </>
        )}
        <span className="text-fg2">{(model || "—").replace(/-/g, "‑")}</span>
        <Sep />
        <span className="text-mute">{language === "zh-CN" ? "强度" : "Effort"} {effort || "—"}</span>
      </div>
    </footer>
  );
}

const Sep = () => <span className="text-faint">·</span>;

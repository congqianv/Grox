/* ─────────────────────────────────────────────────────────────────────────
   EffectiveRuntimePanel — honest dual-state (requested vs applied|unknown).
   A0: read-only; inspect failures degrade (never fake green isolation).
   ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { isComputerUseOperatorEnabled } from "../../lib/computerUse";
import {
  buildEffectiveRuntimeSnapshot,
  isolationLabelText,
  type IsolationDisplay,
} from "../../lib/effectiveRuntime";
import type { GrokInspectSnapshot } from "../../lib/grokInspect";
import { loadGrokInspect } from "../../lib/grokInspectClient";
import { useFeatureFlags, useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";

function toneClass(tone: IsolationDisplay["tone"]): string {
  if (tone === "ok") return "text-green";
  if (tone === "warn") return "text-gold";
  return "text-dim";
}

function inspectStatusText(snap: GrokInspectSnapshot, zh: boolean): string {
  switch (snap.status) {
    case "ok":
      return zh ? "inspect 已加载" : "inspect loaded";
    case "loading":
      return zh ? "inspect 加载中…" : "Loading inspect…";
    case "timeout":
      return zh ? "inspect 超时（已降级）" : "inspect timed out (degraded)";
    case "error":
      return zh ? "inspect 失败（已降级）" : "inspect failed (degraded)";
    case "unavailable":
    default:
      return zh ? "inspect 不可用（浏览器/Mock）" : "inspect unavailable (browser/mock)";
  }
}

export function EffectiveRuntimePanel({ zh }: { zh: boolean }) {
  const workspace = useDesktop((s) => s.workspace);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const sandboxPreference = useDesktop((s) => s.sandboxPreference);
  const [inspect, setInspect] = useState<GrokInspectSnapshot>({
    status: "loading",
    fetchedAt: Date.now(),
  });
  const enabled = useIsFeatureEnabled("effectivePanel");
  const flags = useFeatureFlags();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setInspect((prev) => ({ ...prev, status: "loading" }));
    const snap = await loadGrokInspect(workspace);
    setInspect(snap);
  }, [enabled, workspace]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  if (!enabled) return null;

  const snapshot = buildEffectiveRuntimeSnapshot({
    permissionRequested: permissionMode,
    sandboxRequested: sandboxPreference,
    // Upstream does not yet report applied sandbox on the ACP wire (U-01).
    sandboxApplied: { kind: "unknown", reason: "not_reported_by_agent" },
    permissionApplied: { kind: "unknown", reason: "not_reported_by_agent" },
    cwd: workspace,
    inspect: {
      status:
        inspect.status === "timeout"
          ? "error"
          : inspect.status === "loading"
            ? "loading"
            : inspect.status,
      grokVersion: inspect.grokVersion,
      projectTrusted: inspect.projectTrusted,
      projectRoot: inspect.projectRoot,
      error: inspect.error,
      fetchedAt: inspect.fetchedAt,
    },
    computerUseOptIn: isComputerUseOperatorEnabled(),
    features: {
      sandboxUi: flags.sandboxUi,
      worktreeUi: flags.worktreeUi,
      effectivePanel: flags.effectivePanel,
    },
  });

  const isolation = snapshot.isolation;
  const loading = inspect.status === "loading";

  return (
    <div className="mx-2 mb-2 rounded-[6px] border border-line bg-void/80 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="lbl !text-[9px] !tracking-[0.1em]">
          {zh ? "生效状态" : "EFFECTIVE"}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto flex h-6 w-6 items-center justify-center text-dim hover:bg-high hover:text-fg"
          title={zh ? "刷新 inspect" : "Refresh inspect"}
          aria-label={zh ? "刷新 inspect" : "Refresh inspect"}
        >
          <Icon name="refresh" size={10} className={loading ? "animate-orbit" : ""} />
        </button>
      </div>

      <div className="space-y-1.5 font-mono text-[10px] leading-snug">
        <Row
          label={zh ? "权限 requested" : "Permission requested"}
          value={snapshot.permission.requested}
        />
        <Row
          label={zh ? "权限 applied" : "Permission applied"}
          value={
            snapshot.permission.applied.kind === "known"
              ? snapshot.permission.applied.value
              : zh
                ? "unknown"
                : "unknown"
          }
          muted
        />
        <Row
          label={zh ? "沙箱 requested" : "Sandbox requested"}
          value={snapshot.sandbox.requested}
        />
        <Row
          label={zh ? "沙箱 applied" : "Sandbox applied"}
          value={
            snapshot.sandbox.applied.kind === "known"
              ? snapshot.sandbox.applied.value
              : "unknown"
          }
          muted
        />
        <div className="flex items-start gap-2 pt-0.5">
          <span className="shrink-0 text-faint">{zh ? "隔离" : "Isolation"}</span>
          <span className={`min-w-0 flex-1 text-right ${toneClass(isolation.tone)}`}>
            {isolationLabelText(isolation, zh)}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <span className="shrink-0 text-faint">CU</span>
          <span className="min-w-0 flex-1 text-right text-mute">
            {snapshot.computerUseOptIn
              ? zh
                ? "已 opt-in"
                : "opt-in on"
              : zh
                ? "未开启（独立开关）"
                : "off (independent)"}
          </span>
        </div>
      </div>

      <div className="mt-2 border-t border-line pt-2 font-mono text-[9.5px] text-faint">
        <p>{inspectStatusText(inspect, zh)}</p>
        {inspect.status === "ok" && (
          <p className="mt-0.5 truncate text-mute" title={inspect.projectRoot}>
            CLI {inspect.grokVersion ?? "—"}
            {inspect.projectTrusted === true
              ? zh
                ? " · 项目已信任"
                : " · project trusted"
              : inspect.projectTrusted === false
                ? zh
                  ? " · 项目未信任"
                  : " · project untrusted"
                : ""}
          </p>
        )}
        {inspect.error && inspect.status !== "ok" && (
          <p className="mt-0.5 truncate text-dim" title={inspect.error}>
            {inspect.error}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 text-faint">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-right ${muted ? "text-dim" : "text-mute"}`}>
        {value}
      </span>
    </div>
  );
}

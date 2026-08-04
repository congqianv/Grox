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
        <span className="text-[10px] font-medium tracking-wide text-mute">
          {zh ? "生效状态" : "Effective"}
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

      <div className="space-y-2 text-[10.5px] leading-snug">
        <Field
          label={zh ? "权限 · 请求" : "Permission · requested"}
          value={snapshot.permission.requested}
        />
        <Field
          label={zh ? "权限 · 实际" : "Permission · applied"}
          value={
            snapshot.permission.applied.kind === "known"
              ? snapshot.permission.applied.value
              : "unknown"
          }
          muted
        />
        <Field
          label={zh ? "沙箱 · 请求" : "Sandbox · requested"}
          value={snapshot.sandbox.requested}
        />
        <Field
          label={zh ? "沙箱 · 实际" : "Sandbox · applied"}
          value={
            snapshot.sandbox.applied.kind === "known"
              ? snapshot.sandbox.applied.value
              : "unknown"
          }
          muted
        />
        <Field
          label={zh ? "隔离" : "Isolation"}
          value={isolationLabelText(isolation, zh)}
          valueClass={toneClass(isolation.tone)}
        />
        <Field
          label="Computer Use"
          value={
            snapshot.computerUseOptIn
              ? zh
                ? "已 opt-in"
                : "opt-in on"
              : zh
                ? "未开启（独立开关）"
                : "off (independent)"
          }
        />
      </div>

      <div className="mt-2 border-t border-line pt-2 text-[10px] leading-snug text-faint">
        <p>{inspectStatusText(inspect, zh)}</p>
        {inspect.status === "ok" && (
          <p className="mt-1 break-all text-mute" title={inspect.projectRoot}>
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
          <p className="mt-1 break-all text-dim" title={inspect.error}>
            {inspect.error}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  muted,
  valueClass,
}: {
  label: string;
  value: string;
  muted?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-x-2 gap-y-0.5">
      <span className="min-w-0 text-faint">{label}</span>
      <span
        className={`min-w-0 break-words text-right font-mono ${valueClass ?? (muted ? "text-dim" : "text-mute")}`}
      >
        {value}
      </span>
    </div>
  );
}

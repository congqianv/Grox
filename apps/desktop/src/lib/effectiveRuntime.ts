/**
 * Dual-state runtime model: requested vs applied|unknown (A0).
 *
 * UI honesty rule (I-03 / product): never show a green "isolated" tone when
 * applied status is unknown. Inspect failures degrade to unknown, not false greens.
 */

import type { PermissionMode } from "../bridge/types";
import type { SandboxPreference } from "./sandboxPolicy";

/** Applied side of dual-state: known value or unknown (inspect/agent silent). */
export type AppliedStatus<T> =
  | { kind: "known"; value: T }
  | { kind: "unknown"; reason?: string };

export interface DualStateField<T> {
  requested: T;
  applied: AppliedStatus<T>;
}

export type IsolationTone = "neutral" | "ok" | "warn";

export type IsolationLabelKey =
  | "follow_cli"
  | "unknown"
  | "requested_only"
  | "isolated"
  | "sandbox_off";

export interface IsolationDisplay {
  tone: IsolationTone;
  labelKey: IsolationLabelKey;
  /** Present only when tone is ok and applied sandbox is known. */
  sandbox?: string;
}

/**
 * Map dual-state sandbox field to UI display. **Never** returns tone "ok"
 * when applied is unknown (no fake green isolation).
 */
export function isolationDisplay(
  field: DualStateField<SandboxPreference>,
): IsolationDisplay {
  if (field.requested === "follow_cli") {
    if (field.applied.kind === "unknown") {
      return { tone: "neutral", labelKey: "follow_cli" };
    }
    if (field.applied.value === "follow_cli" || field.applied.value === "off") {
      return {
        tone: field.applied.value === "off" ? "warn" : "neutral",
        labelKey: field.applied.value === "off" ? "sandbox_off" : "follow_cli",
      };
    }
    // Applied known from inspect while user follows CLI — show real profile, not fake request.
    if (field.applied.value === "workspace" || field.applied.value === "read_only") {
      return {
        tone: "ok",
        labelKey: "isolated",
        sandbox: field.applied.value === "read_only" ? "read-only" : "workspace",
      };
    }
    return { tone: "neutral", labelKey: "follow_cli" };
  }

  if (field.applied.kind === "unknown") {
    // Explicit request but not confirmed applied — neutral, not green.
    return { tone: "neutral", labelKey: "requested_only" };
  }

  if (field.applied.value === "off" || field.requested === "off") {
    return { tone: "warn", labelKey: "sandbox_off" };
  }

  if (field.applied.value === "workspace" || field.applied.value === "read_only") {
    return {
      tone: "ok",
      labelKey: "isolated",
      sandbox: field.applied.value === "read_only" ? "read-only" : "workspace",
    };
  }

  return { tone: "neutral", labelKey: "unknown" };
}

export interface EffectiveRuntimeInput {
  permissionRequested: PermissionMode;
  /** From agent/session when known; otherwise unknown. */
  permissionApplied?: AppliedStatus<PermissionMode>;
  sandboxRequested: SandboxPreference;
  sandboxApplied?: AppliedStatus<SandboxPreference>;
  cwd: string;
  /** grok inspect snapshot summary fields (optional). */
  inspect?: {
    status: "ok" | "error" | "unavailable" | "loading";
    grokVersion?: string;
    projectTrusted?: boolean;
    projectRoot?: string;
    error?: string;
    fetchedAt?: number;
  };
  computerUseOptIn: boolean;
  features: {
    sandboxUi: boolean;
    worktreeUi: boolean;
    effectivePanel: boolean;
  };
}

export interface EffectiveRuntimeSnapshot {
  permission: DualStateField<PermissionMode>;
  sandbox: DualStateField<SandboxPreference>;
  isolation: IsolationDisplay;
  cwd: string;
  inspect: NonNullable<EffectiveRuntimeInput["inspect"]>;
  computerUseOptIn: boolean;
  features: EffectiveRuntimeInput["features"];
}

export function buildEffectiveRuntimeSnapshot(
  input: EffectiveRuntimeInput,
): EffectiveRuntimeSnapshot {
  const permission: DualStateField<PermissionMode> = {
    requested: input.permissionRequested,
    applied: input.permissionApplied ?? { kind: "unknown", reason: "not_reported" },
  };
  const sandbox: DualStateField<SandboxPreference> = {
    requested: input.sandboxRequested,
    applied: input.sandboxApplied ?? { kind: "unknown", reason: "not_reported" },
  };
  return {
    permission,
    sandbox,
    isolation: isolationDisplay(sandbox),
    cwd: input.cwd,
    inspect: input.inspect ?? { status: "unavailable" },
    computerUseOptIn: input.computerUseOptIn,
    features: input.features,
  };
}

/** Human label for isolation (zh/en). Pure string helper for tests + UI. */
export function isolationLabelText(
  display: IsolationDisplay,
  zh: boolean,
): string {
  switch (display.labelKey) {
    case "follow_cli":
      return zh ? "跟随 CLI（未由壳强制）" : "Follow CLI (shell does not force)";
    case "unknown":
      return zh ? "隔离状态未知" : "Isolation status unknown";
    case "requested_only":
      return zh ? "已请求 · 未确认生效" : "Requested · not confirmed applied";
    case "isolated":
      return zh
        ? `已隔离（${display.sandbox ?? "sandbox"}）`
        : `Isolated (${display.sandbox ?? "sandbox"})`;
    case "sandbox_off":
      return zh ? "沙箱关闭（允许，有风险）" : "Sandbox off (allowed, risky)";
    default:
      return zh ? "未知" : "Unknown";
  }
}

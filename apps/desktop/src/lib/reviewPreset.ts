/**
 * Review mode preset (D) — optional entry; does not force enterprise locks.
 * Default review is read-leaning; "allow edits" is one click away.
 */

import type { AgentMode, PermissionMode } from "../bridge/types";
import type { SandboxPreference } from "./sandboxPolicy";

export interface ReviewPreset {
  mode: AgentMode;
  permissionMode: PermissionMode;
  /** Applied only when sandboxUi is enabled; otherwise ignored by caller. */
  sandboxPreference: SandboxPreference;
  labelKey: "review_readonly" | "review_allow_edits";
}

/** Read-only / audit leaning — confirm tools, read-only sandbox request. */
export function reviewPresetReadonly(): ReviewPreset {
  return {
    mode: "ask",
    permissionMode: "default",
    sandboxPreference: "read_only",
    labelKey: "review_readonly",
  };
}

/** Allow modifications while still reasonable (auto + workspace). */
export function reviewPresetAllowEdits(): ReviewPreset {
  return {
    mode: "agent",
    permissionMode: "auto",
    sandboxPreference: "workspace",
    labelKey: "review_allow_edits",
  };
}

export function reviewPreset(allowEdits: boolean): ReviewPreset {
  return allowEdits ? reviewPresetAllowEdits() : reviewPresetReadonly();
}

export function reviewPresetLabel(preset: ReviewPreset, zh: boolean): string {
  if (preset.labelKey === "review_allow_edits") {
    return zh ? "Review · 允许修改" : "Review · allow edits";
  }
  return zh ? "Review · 只读审查" : "Review · read-only";
}

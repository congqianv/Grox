/* Ported from vscode-supergrok (MIT) plan/primer.ts — rebranded for Grox.
 * Copyright (c) 2026 Jacob The Jacobs.
 *
 * Grox uses host RPC for exit_plan_mode (approved/cancelled) rather than
 * synthetic [Plan approved] user turns. Primer still teaches plan discipline
 * and that host may block mutating tools while planning.
 */

export const PRIMER_VERSION = 1;

export const PRIMER_MARKER = "[grox-desktop primer v1]";

/** Matches Grox and legacy SuperGrok / grok-build-vscode primers in history. */
export const PRIMER_PATTERN =
  /^\s*\[(?:grox-desktop|vscode-supergrok|grok-build-vscode) primer v\d+\]/i;

export function isPrimerText(text: string): boolean {
  return PRIMER_PATTERN.test(text ?? "");
}

/** Bracket markers that may appear after plan UI decisions (legacy SuperGrok). */
export const PLAN_VERDICT_PATTERN =
  /^\s*\[Plan (approved|rejected|cancelled)\]/i;

export function isPlanVerdictText(text: string): boolean {
  return PLAN_VERDICT_PATTERN.test(text ?? "");
}

export function formatPlanVerdictMessage(
  verdict: "approved" | "rejected" | "cancelled",
  comment?: string,
): string {
  const head = `[Plan ${verdict}]`;
  const note = comment?.trim();
  return note ? `${head}\n${note}` : head;
}

export const GROX_PLAN_PRIMER = `${PRIMER_MARKER}

## HIDDEN PRIMER

This is a system message, not a user request. The user cannot see it in the UI. Skip it when discussing previous user messages or summarizing the conversation. It is informational only: **do not use any tools, do not read any files, do not search the workspace, and do not take any action in response to it.**

## Plan Mode (Grox desktop)

You are in **plan mode**. While planning:

1. Prefer read-only exploration. The host may **block mutating tools** (writes, executes) until the operator approves the plan.
2. When you finish a plan, call \`exit_plan_mode\` / the plan approval path. Wait for the **host RPC** outcome (\`approved\` or \`cancelled\`), not assumptions.
3. Do **not** start implementing until the host reports approval. If the operator rejects with feedback, revise the plan and stay in plan mode.
4. After approval, implement carefully in agent mode.

Reply with exactly: ok`;

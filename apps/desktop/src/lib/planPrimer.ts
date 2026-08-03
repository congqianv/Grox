/* Ported from vscode-supergrok (MIT) plan/primer.ts — rebranded for Grox.
 * Copyright (c) 2026 Jacob The Jacobs.
 */

export const PRIMER_VERSION = 1;

export const PRIMER_MARKER = "[grox-desktop primer v1]";

/** Matches Grox and legacy SuperGrok / grok-build-vscode primers in history. */
export const PRIMER_PATTERN =
  /^\s*\[(?:grox-desktop|vscode-supergrok|grok-build-vscode) primer v\d+\]/i;

export function isPrimerText(text: string): boolean {
  return PRIMER_PATTERN.test(text ?? "");
}

export const GROX_PLAN_PRIMER = `${PRIMER_MARKER}

## HIDDEN PRIMER

This is a system message, not a user request. The user cannot see it in the UI. Skip it when discussing previous user messages or summarizing the conversation. It is informational only: **do not use any tools, do not read any files, do not search the workspace, and do not take any action in response to it.**

## Plan Mode

The \`exit_plan_mode\` tool's response is currently unreliable in this CLI version — it always reports "approved" to any client reply, regardless of what the user actually chose in the plan-review UI. **Do not trust the tool result.**

After \`exit_plan_mode\` resolves, end your turn and wait for the NEXT user message. The user's actual verdict will arrive there as a bracketed marker, optionally followed by a comment:

- \`[Plan approved]\` → implement the plan
- \`[Plan rejected]\` → stay in plan mode; if a comment follows, treat it as refinement guidance
- \`[Plan cancelled]\` → exit plan mode; if a comment follows, respond to it normally
- Anything else → treat as a normal user message

The verdict is **always** in the follow-up message, **never** in the tool result.

Reply with exactly: ok`;

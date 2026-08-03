import type { PermissionMode } from "../bridge/types";

/**
 * Tools that Auto mode may approve without a card (read-ish / low risk).
 * Execute/write/delete/computer/subagent/media still require a card under Auto.
 * Bypass mode auto-approves everything (trusted environments only).
 *
 * Gate is intentionally lower than first ship: cover common read/search/LSP/
 * browse names so Auto feels useful without becoming YOLO.
 */
// Underscores are word chars — use non-word boundaries so `read_file` matches.
const AUTO_SAFE_KIND_RE =
  /(^|[^a-z0-9_])(read(_file|_resource|_text|_query|_pdf)?|list(_dir|_files|_resources|_tools)?|search|glob|grep|find|ls|dir|stat|cat|head|tail|web(_search|_fetch)?|web_search|web_fetch|fetch|browse|open_page|open_file|preview|memory(_get|_search)?|skill|todo(_read|_list|_get)?|plan|info|diagnostics?|view|show|inspect|describe|symbol|definition|references?|hover|typecheck|lint|check|status|outline|document|semantic_search|codebase_search|get_file|get_content|get_file_content|file_search|path_search|rg)([^a-z0-9_]|$)/i;

/** Shell, FS mutation, agents, media cost, deploy — never Auto-approve. */
const AUTO_UNSAFE_KIND_RE =
  /(^|[^a-z0-9_])(exec(ute)?|terminal|bash|shell|cmd|powershell|write(_file)?|edit|delete|remove|move|rename|apply_patch|computer|spawn|subagent|kill|task|image_gen|video_gen|image_to_video|reference_to_video|media|deploy|run_terminal|run_command|bash_tool)([^a-z0-9_]|$)/i;

/** Costly / high-impact tools (execute/write/spawn/media). Auto never silent-allows these. */
export function isElevatedToolLabel(toolLabel: string): boolean {
  return AUTO_UNSAFE_KIND_RE.test(toolLabel || "");
}

/**
 * Decide whether FE may auto-select allow for a tool permission request.
 * Pure — unit-tested.
 *
 * YOLO/bypass must never be blocked by an already-open card: stacking
 * `hasOpenManualGate` used to leave execute cards open and then force every
 * later tool (even under YOLO) through manual UI — matches the operator report
 * "切到 YOLO 仍然一直要授权".
 */
export function shouldAutoApproveToolPermission(input: {
  permissionMode: PermissionMode;
  /** Tool title / kind / name blob for classification. */
  toolLabel: string;
  /** Computer Use MCP tool and operator has CU opt-in. */
  computerUseAuto: boolean;
  /** Another permission/plan/question card is already open for this session. */
  hasOpenManualGate: boolean;
}): boolean {
  // Bypass = YOLO for trusted envs: always silent-allow tools (plan/question
  // are separate request kinds and still require a card).
  if (input.permissionMode === "bypass") return true;

  // CU tools with opt-in: auto regardless of DEFAULT/AUTO (not blocked by YOLO path above).
  // Still respect an open manual gate so CU does not race past a visible card.
  if (input.computerUseAuto) {
    return !input.hasOpenManualGate;
  }

  if (input.permissionMode === "default") return false;

  // auto: only safe read-ish tools. An open *unsafe* gate must not cascade into
  // cards for later safe tools (that felt like "自动策略也一直要授权").
  if (input.permissionMode === "auto") {
    const label = input.toolLabel || "";
    if (AUTO_UNSAFE_KIND_RE.test(label)) return false;
    if (!AUTO_SAFE_KIND_RE.test(label)) {
      // Unknown tools: do not auto under Auto (safer than YOLO).
      return false;
    }
    // Safe tool: allow even when another card is open (independent RPC).
    return true;
  }

  return false;
}

/**
 * Preferred option id for silent auto-approve.
 * Always prefer once over always — sticky allow_always can outlive a mode switch
 * back to Default and suppress future prompts.
 */
export function pickSilentAllowOptionId(optionIds: {
  allow_once?: string;
  allow_always?: string;
}): string | undefined {
  return optionIds.allow_once ?? optionIds.allow_always;
}

/** Build a classification string from common permission tool fields. */
export function permissionToolLabel(parts: {
  title?: unknown;
  kind?: unknown;
  name?: unknown;
  toolName?: unknown;
}): string {
  return [parts.title, parts.kind, parts.name, parts.toolName]
    .map((v) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .join(" ");
}

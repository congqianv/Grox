/* Derive live subagents from the active session's tool transcript. */

import type { Session, ToolCall, ToolKind, ToolStatus } from "../bridge/types";

export interface ActiveSubagent {
  id: string;
  blockId: string;
  /** Primary line shown in the list. */
  title: string;
  /** Secondary detail (type, description). */
  detail?: string;
  /** Best-effort agent type: explore / plan / general-purpose / … */
  agentType: string;
  status: ToolStatus;
  startedAt: number;
  /** Tool end time when finished (for duration). */
  endedAtHint?: number;
  kind: ToolKind;
}

export interface SubagentTone {
  text: string;
  bg: string;
  border: string;
  dot: string;
}

/** Rotating palette so concurrent subagents stay visually distinct. */
const TONES: SubagentTone[] = [
  { text: "text-gold", bg: "bg-gold/10", border: "border-gold/35", dot: "bg-gold" },
  { text: "text-green", bg: "bg-green/10", border: "border-green/35", dot: "bg-green" },
  { text: "text-acc", bg: "bg-acc/10", border: "border-acc/30", dot: "bg-acc" },
  { text: "text-red", bg: "bg-red/10", border: "border-red/30", dot: "bg-red" },
  { text: "text-fg2", bg: "bg-high", border: "border-line3", dot: "bg-fg2" },
  { text: "text-mute", bg: "bg-high", border: "border-line2", dot: "bg-mute" },
];

/** Prefer a stable color per known agent type; fall back to id hash. */
const TYPE_TONE: Record<string, number> = {
  explore: 1,
  plan: 0,
  "general-purpose": 2,
  general: 2,
  research: 1,
  review: 3,
  implement: 2,
  test: 1,
  code: 2,
};

const ACTIVE: ReadonlySet<ToolStatus> = new Set(["pending", "running", "awaiting_permission"]);
const FINISHED: ReadonlySet<ToolStatus> = new Set(["done", "cancelled", "error"]);

function callBlob(call: ToolCall): string {
  return `${call.rawKind ?? ""} ${call.title} ${call.detail ?? ""} ${call.input ?? ""}`.toLowerCase();
}

/** Shell / harness tools that must never appear as "subagents". */
export function looksLikeShellTool(call: ToolCall): boolean {
  if (
    call.kind === "execute" ||
    call.kind === "terminal" ||
    call.kind === "monitor" ||
    call.kind === "background_task_action" ||
    call.kind === "wait_tasks_action" ||
    call.kind === "kill_task_action"
  ) {
    return true;
  }
  const head = `${call.title} ${call.detail ?? ""}`.trim();
  if (/^(execute|command|run|shell|cmd)\b/i.test(head)) return true;
  if (/^\[bg\]/i.test(head)) return true;
  if (
    /select-string|foreach-object|write-output|powershell|bash\s|cmd\.exe|\/c\s|git\s+(status|diff|log)\b/i.test(
      head,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Harness / shell noise that used to pollute the subagent rail
 * (e.g. get_command_or_subagent_output, bare Task call-uuid shells).
 */
export function isSubagentNoise(call: ToolCall): boolean {
  if (looksLikeShellTool(call)) return true;
  const blob = callBlob(call);
  if (
    /get_command_or_subagent|wait_tasks|kill_task|list_tasks|background_task_action|wait_tasks_action|kill_task_action|list_task/.test(
      blob,
    )
  ) {
    return true;
  }
  // Shell "Task call-<uuid>" without agent metadata
  if (/task\s*call-[a-f0-9-]{8,}/i.test(`${call.title} ${call.detail ?? ""}`)) {
    if (!/"subagent_type"|spawn_subagent|subagent_type\s*[:=]/.test(blob)) {
      return true;
    }
  }
  return false;
}

/** Structured / strong signals that identify a nested agent spawn. */
function hasStrongSubagentSignal(blob: string): boolean {
  if (/spawn_subagent/.test(blob)) return true;
  if (/"subagent_type"\s*:|subagent_type\s*[:=]/.test(blob)) return true;
  if (/\bsubagent\b|子代理/.test(blob) && !/get_command_or_subagent/.test(blob)) return true;
  return false;
}

/**
 * Role token from structured prefix / subagent_type only — not bare substring includes.
 * Avoids "Fix general bug" / "plan the release" false positives.
 */
function structuredAgentRole(call: ToolCall): string | null {
  const detail = call.detail ?? "";
  const title = call.title ?? "";
  const input = call.input ?? "";

  const fromDetail = detail.match(
    /^\s*([a-z][a-z0-9_-]*)\s*[·•|]\s+/i,
  );
  if (fromDetail?.[1]) return fromDetail[1].toLowerCase();

  const fromTitle = title.match(
    /^\s*([a-z][a-z0-9_-]*)\s*[·•|]\s+/i,
  );
  if (fromTitle?.[1]) return fromTitle[1].toLowerCase();

  const fromInput =
    input.match(/"subagent_type"\s*:\s*"([^"]+)"/i) ??
    input.match(/subagent_type["\s:=]+([a-z][a-z0-9_-]*)/i);
  if (fromInput?.[1]) return fromInput[1].toLowerCase();

  // Explicit agent-role titles (not casual English words in prose).
  if (/^(code-reviewer|reviewer|architect|general-purpose)\b/i.test(title.trim())) {
    return title.trim().split(/[\s·•|]/)[0]!.toLowerCase();
  }
  if (/\b(code-reviewer|architect)\b/i.test(`${title} ${detail}`)) {
    return "review";
  }
  return null;
}

/**
 * Real subagents only (Codex-style): spawn_subagent / subagent_type / structured roles.
 * Plain shell execute/task tools and poll helpers are excluded.
 * Strong signals win over shell-kind short-circuit (wire may map spawn to execute).
 */
export function isRealSubagentCall(call: ToolCall): boolean {
  const blob = callBlob(call);

  // Strong signals first — never lose real spawns to shell kind noise.
  if (hasStrongSubagentSignal(blob)) return true;

  if (isSubagentNoise(call)) return false;

  const role = structuredAgentRole(call);
  if (!role) return false;

  // Structured role + agent-ish kind/title only (no bare blob.includes role words).
  if (looksLikeShellTool(call)) return false;
  if (call.kind === "task" || call.kind === "other") return true;
  if (/agent|spawn|reviewer|子代理/.test(blob)) return true;
  return false;
}

function subagentTitle(call: ToolCall): string {
  // Prefer human description over raw Task call-uuid titles.
  const detail = call.detail?.trim();
  if (detail && !/^task\s*call-/i.test(detail) && detail.length < 200) {
    // Strip leading "explore · " style prefix for the body if whole line is long
    return detail;
  }
  const title = call.title?.trim() || call.id;
  if (/^task\s*call-/i.test(title) && detail) {
    return detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  }
  return title;
}

function subagentDetail(call: ToolCall, title: string): string | undefined {
  if (call.title && call.title !== title && !/^task\s*call-/i.test(call.title)) {
    return call.title;
  }
  return undefined;
}

/** Pull explore/plan/… from "explore · …", input JSON, or title. */
export function parseAgentType(call: ToolCall): string {
  const detail = call.detail ?? "";
  const title = call.title ?? "";
  const input = call.input ?? "";

  const fromDetail = detail.match(
    /^\s*([a-z][a-z0-9_-]*(?:\s*[·•|]\s*|\s+-\s+))/i,
  );
  if (fromDetail) {
    const token = fromDetail[1].replace(/\s*[·•|\-].*$/, "").trim().toLowerCase();
    if (token) return token;
  }

  const fromInput =
    input.match(/"subagent_type"\s*:\s*"([^"]+)"/i) ??
    input.match(/subagent_type["\s:=]+([a-z][a-z0-9_-]*)/i);
  if (fromInput?.[1]) return fromInput[1].toLowerCase();

  const blob = `${detail} ${title} ${input}`.toLowerCase();
  // Prefer longer keys first so "general-purpose" wins over "general"
  const keys = Object.keys(TYPE_TONE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (blob.includes(key)) return key;
  }
  return "subagent";
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Color for one subagent — stable across re-renders for the same agent. */
export function subagentTone(agent: Pick<ActiveSubagent, "id" | "agentType">, index = 0): SubagentTone {
  const typeKey = agent.agentType.toLowerCase();
  if (typeKey in TYPE_TONE) return TONES[TYPE_TONE[typeKey] % TONES.length];
  return TONES[(hashId(agent.id) + index) % TONES.length];
}

function toActive(blockId: string, call: ToolCall): ActiveSubagent {
  const title = subagentTitle(call);
  return {
    id: call.id,
    blockId,
    title,
    detail: subagentDetail(call, title),
    agentType: parseAgentType(call),
    status: call.status,
    startedAt: call.startedAt,
    endedAtHint: call.endedAt,
    kind: call.kind,
  };
}

/** Active real subagents only (shell / poll tools excluded). Live first by recency. */
export function extractActiveSubagents(session: Session | null | undefined): ActiveSubagent[] {
  if (!session) return [];
  const out: ActiveSubagent[] = [];
  for (const block of session.blocks) {
    if (block.type !== "tool") continue;
    const { call } = block;
    if (!ACTIVE.has(call.status)) continue;
    if (!isRealSubagentCall(call)) continue;
    out.push(toActive(block.id, call));
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/**
 * Recent finished real subagents. Newest first.
 */
export function extractRecentSubagents(
  session: Session | null | undefined,
  limit = 8,
): ActiveSubagent[] {
  if (!session) return [];
  const out: ActiveSubagent[] = [];
  for (const block of session.blocks) {
    if (block.type !== "tool") continue;
    const { call } = block;
    if (!FINISHED.has(call.status)) continue;
    if (!isRealSubagentCall(call)) continue;
    out.push(toActive(block.id, call));
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, Math.max(0, limit));
}

/** Focus a timeline tool card by block id (B1 click-to-locate). */
export function focusTimelineBlock(blockId: string): boolean {
  if (typeof document === "undefined") return false;
  const safe =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(blockId)
      : blockId.replace(/["\\]/g, "\\$&");
  const el =
    document.querySelector(`[data-block-id="${safe}"]`) ??
    document.getElementById(`block-${blockId}`);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-1", "ring-acc/50");
  window.setTimeout(() => {
    el.classList.remove("ring-1", "ring-acc/50");
  }, 1600);
  return true;
}

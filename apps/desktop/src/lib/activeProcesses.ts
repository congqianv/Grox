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

function isSubagentCall(call: ToolCall): boolean {
  if (call.kind === "task") return true;
  const raw = `${call.rawKind ?? ""} ${call.title} ${call.detail ?? ""}`.toLowerCase();
  return /subagent|spawn_subagent/.test(raw);
}

function subagentTitle(call: ToolCall): string {
  if (call.detail?.trim()) return call.detail.trim();
  return call.title;
}

function subagentDetail(call: ToolCall, title: string): string | undefined {
  if (call.title && call.title !== title) return call.title;
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
  for (const key of Object.keys(TYPE_TONE)) {
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
  // Mix list index + id so two unknown agents still differ.
  return TONES[(hashId(agent.id) + index) % TONES.length];
}

/** Active subagents only — shell / monitor / background tools are ignored. */
export function extractActiveSubagents(session: Session | null | undefined): ActiveSubagent[] {
  if (!session) return [];
  const out: ActiveSubagent[] = [];
  for (const block of session.blocks) {
    if (block.type !== "tool") continue;
    const { call } = block;
    if (!ACTIVE.has(call.status)) continue;
    if (!isSubagentCall(call)) continue;
    const title = subagentTitle(call);
    out.push({
      id: call.id,
      blockId: block.id,
      title,
      detail: subagentDetail(call, title),
      agentType: parseAgentType(call),
      status: call.status,
      startedAt: call.startedAt,
      kind: call.kind,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

const FINISHED: ReadonlySet<ToolStatus> = new Set(["done", "cancelled", "error"]);

/**
 * Recent finished subagents for the history strip (B1).
 * Newest first; capped so the composer stays compact.
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
    if (!isSubagentCall(call)) continue;
    const title = subagentTitle(call);
    out.push({
      id: call.id,
      blockId: block.id,
      title,
      detail: subagentDetail(call, title),
      agentType: parseAgentType(call),
      status: call.status,
      startedAt: call.startedAt,
      kind: call.kind,
    });
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

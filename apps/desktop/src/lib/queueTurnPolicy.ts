/**
 * Pure decision helpers for queue / interject / stop.
 * Mirrors store + Composer branching so smoke scenarios stay unit-testable
 * without spinning up Tauri / ACP.
 */
import type { SessionStatus } from "../bridge/types";
import {
  normalizeQueueText,
  queueHasSameText,
  type QueueEntryLike,
} from "./promptQueue";

export type TurnKind = "idle" | "running" | "gated";

export function classifyTurnStatus(status: SessionStatus): TurnKind {
  if (status === "idle") return "idle";
  if (status === "awaiting_permission" || status === "awaiting_input") return "gated";
  return "running"; // running + any unexpected non-idle treated as busy
}

/** Composer button visibility (matches Composer.tsx). */
export function composerAffordances(kind: TurnKind): {
  showSend: boolean;
  showStop: boolean;
  showQueue: boolean;
  showInterject: boolean;
} {
  if (kind === "idle") {
    return { showSend: true, showStop: false, showQueue: false, showInterject: false };
  }
  if (kind === "running") {
    return { showSend: false, showStop: true, showQueue: true, showInterject: true };
  }
  // gated
  return { showSend: false, showStop: true, showQueue: true, showInterject: false };
}

/**
 * Enter / 「加入队列」 path.
 * - idle → primary session/prompt (may silent-bind first)
 * - running → local queue + concurrent session/prompt
 * - gated → local queue only; drain on idle
 */
export type SendPath = "primary" | "concurrent_queue" | "local_gate_queue";

export function resolveSendPath(kind: TurnKind): SendPath {
  if (kind === "idle") return "primary";
  if (kind === "gated") return "local_gate_queue";
  return "concurrent_queue";
}

/**
 * Ctrl+Enter / 「插话」 path.
 * - idle → same as primary send
 * - gated → local queue only (no interject RPC mid-permission)
 * - running → true interject RPC (or fallback pin)
 */
export type InterjectPath = "primary" | "local_gate_queue" | "interject_rpc";

export function resolveInterjectPath(kind: TurnKind): InterjectPath {
  if (kind === "idle") return "primary";
  if (kind === "gated") return "local_gate_queue";
  return "interject_rpc";
}

/**
 * Whether drainPromptQueue may fire a local follow-up.
 * Stop sets suppressNextIdleDrain until operator re-sends / clears / reconnects.
 */
export function shouldDrainQueue(input: {
  status: SessionStatus;
  suppressNextIdleDrain: boolean;
  queue: readonly QueueEntryLike[];
  submittedIds?: ReadonlySet<string>;
}): boolean {
  if (input.status !== "idle") return false;
  if (input.suppressNextIdleDrain) return false;
  return nextDrainableIndex(input.queue, input.submittedIds) >= 0;
}

/**
 * Next local row eligible for idle drain (mirrors store drainPromptQueue).
 * Skips CLI, sending, and in-flight submitted concurrent ids — never drops them.
 */
export function nextDrainableIndex(
  queue: readonly QueueEntryLike[],
  submittedIds?: ReadonlySet<string> | null,
): number {
  return queue.findIndex(
    (item) =>
      item.source !== "cli" &&
      item.state !== "sending" &&
      !(submittedIds?.has(item.id) ?? false),
  );
}

/**
 * Interject accept / reject before wire (mirrors interjectPrompt dedup).
 * - queue same text → drop queue rows then accept interject
 * - live turn same text → reject
 * - concurrent-consumed same text → reject
 */
export type InterjectDedup =
  | { action: "accept"; dropQueueText: boolean }
  | { action: "reject"; reason: "live" | "consumed" };

export function resolveInterjectDedup(input: {
  text: string;
  queue: readonly { text?: string }[];
  liveTurnTexts: readonly string[];
  consumedTexts?: ReadonlySet<string> | null;
}): InterjectDedup {
  const norm = normalizeQueueText(input.text);
  if (!norm) return { action: "accept", dropQueueText: false };

  if (
    input.liveTurnTexts.some((t) => normalizeQueueText(t) === norm)
  ) {
    return { action: "reject", reason: "live" };
  }
  if (input.consumedTexts?.has(norm)) {
    return { action: "reject", reason: "consumed" };
  }
  const inQueue = queueHasSameText(input.queue, input.text);
  return { action: "accept", dropQueueText: inQueue };
}

/**
 * After last gate resolves while agent still working: status becomes running,
 * not idle — so local gate queue must NOT drain yet.
 */
export function gateQueueDrainsOnlyOnIdle(
  statusAfterGateResolve: SessionStatus,
): boolean {
  return statusAfterGateResolve === "idle";
}

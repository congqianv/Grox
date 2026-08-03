import type { Session, SessionBlock, SessionStatus } from "../bridge/types";
import { isPrimerText } from "./planPrimer";

/** True when the live session must not be forced idle by a disk merge. */
export function isLiveBusyStatus(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "awaiting_permission" || status === "awaiting_input";
}

/**
 * Content fingerprint for offline/live block identity.
 * Offline disk IDs and optimistic UI UUIDs almost never match — without this,
 * mergeOfflineWithLive appends the entire live transcript after disk history
 * (full duplicate conversation after scan completes).
 */
/** Drop hidden plan primers from offline/live transcripts before merge/display. */
export function stripPrimerBlocks(blocks: SessionBlock[]): SessionBlock[] {
  return blocks.filter((block) => !(block.type === "user" && isPrimerText(block.text)));
}

export function blockContentKey(block: SessionBlock): string {
  switch (block.type) {
    case "user":
      return `user:${block.interjected ? "i:" : ""}${block.text.trim().slice(0, 240)}`;
    case "assistant":
      return `assistant:${block.text.trim().slice(0, 240)}`;
    case "thinking":
      return `thinking:${block.text.trim().slice(0, 160)}`;
    case "tool":
      return `tool:${block.call.id || block.call.title}:${block.call.kind}`;
    case "plan":
      return `plan:${block.steps.map((s) => s.content).join("|").slice(0, 160)}`;
    case "permission":
      return `perm:${block.id}:${block.req?.title ?? ""}`;
    case "question":
      return `q:${block.id}`;
    case "system":
      return `sys:${block.kind ?? ""}:${block.text.trim().slice(0, 120)}`;
    default:
      return `other:${(block as SessionBlock).type}:${(block as SessionBlock).id}`;
  }
}

/**
 * Merge offline disk history with any live-only blocks still on the session.
 * Preserves busy turn status so a late disk scan cannot unlock send mid-turn.
 *
 * When idle, offline is preferred as the authority if it is at least as rich
 * (by content keys). Live-only streaming / optimistic bubbles are appended
 * when their content is not already present on disk.
 */
export function mergeOfflineWithLive(pending: Session, cur: Session | undefined): Session {
  const busyStatus = cur && isLiveBusyStatus(cur.status) ? cur.status : null;
  const status = busyStatus ?? ("idle" as const);
  const pendingClean: Session = {
    ...pending,
    blocks: stripPrimerBlocks(pending.blocks),
  };
  const curClean = cur
    ? { ...cur, blocks: stripPrimerBlocks(cur.blocks) }
    : undefined;

  if (!curClean || curClean.blocks.length === 0) {
    return { ...pendingClean, status };
  }

  const pendingKeys = new Set(pendingClean.blocks.map(blockContentKey));
  const liveOnly = curClean.blocks.filter((b) => !pendingKeys.has(blockContentKey(b)));

  // Idle + offline covers live content → offline is authoritative (no ghost twin turns).
  if (!busyStatus && liveOnly.length === 0) {
    return {
      ...pendingClean,
      status: "idle",
      usage: curClean.usage?.outputTokens ? curClean.usage : pendingClean.usage,
    };
  }

  // Idle + offline is longer (or equal) by block count and covers most of live:
  // still prefer offline + residual liveOnly (e.g. brand-new unsent paint).
  if (
    !busyStatus &&
    pendingClean.blocks.length >= curClean.blocks.length &&
    liveOnly.length === 0
  ) {
    return {
      ...pendingClean,
      status: "idle",
      usage: curClean.usage?.outputTokens ? curClean.usage : pendingClean.usage,
    };
  }

  // Live strictly longer by raw length AND no content overlap path for residuals:
  // keep live when offline is a short cache prefix of the same session (legacy).
  // Prefer content-based append when offline is longer or equal.
  if (
    curClean.blocks.length > pendingClean.blocks.length &&
    liveOnly.length === curClean.blocks.length
  ) {
    // Zero content overlap (total ID/content mismatch): offline + live would
    // double the transcript. Prefer the longer stream while busy; while idle
    // prefer offline when it has more blocks (richer disk history).
    if (
      !busyStatus &&
      pendingClean.blocks.length >= Math.floor(curClean.blocks.length * 0.5)
    ) {
      // Heuristic: disk recovered a large history; live is likely cache+optimistic.
      // Keep offline and only append live blocks that look like a trailing turn
      // (last few user/assistant after offline end).
      const trailing = pickTrailingLiveOnly(curClean.blocks, pendingKeys);
      return {
        ...pendingClean,
        status: "idle",
        blocks:
          trailing.length > 0
            ? [...pendingClean.blocks, ...trailing]
            : pendingClean.blocks,
        usage: curClean.usage?.outputTokens ? curClean.usage : pendingClean.usage,
      };
    }
    return { ...curClean, status };
  }

  if (liveOnly.length === 0) {
    return {
      ...pendingClean,
      status,
      usage: curClean.usage?.outputTokens ? curClean.usage : pendingClean.usage,
    };
  }

  return {
    ...pendingClean,
    status,
    blocks: [...pendingClean.blocks, ...liveOnly],
    usage: curClean.usage?.outputTokens ? curClean.usage : pendingClean.usage,
  };
}

/**
 * When offline and live share almost no content keys (UUID vs disk ids),
 * only keep a short trailing live suffix that looks like the current turn
 * (last user + following blocks), not the entire live transcript.
 */
function pickTrailingLiveOnly(
  liveBlocks: SessionBlock[],
  pendingKeys: Set<string>,
): SessionBlock[] {
  // Walk from end: collect from last unmatched user through end.
  let start = -1;
  for (let i = liveBlocks.length - 1; i >= 0; i -= 1) {
    const b = liveBlocks[i];
    if (b.type === "user" && !pendingKeys.has(blockContentKey(b))) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    // No new user — keep last unmatched assistant/tool burst (max 12).
    const tail: SessionBlock[] = [];
    for (let i = liveBlocks.length - 1; i >= 0 && tail.length < 12; i -= 1) {
      const b = liveBlocks[i];
      if (pendingKeys.has(blockContentKey(b))) break;
      tail.unshift(b);
    }
    return tail;
  }
  return liveBlocks.slice(start).filter((b) => !pendingKeys.has(blockContentKey(b)));
}

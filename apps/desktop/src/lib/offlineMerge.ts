import type { Session, SessionStatus } from "../bridge/types";

/** True when the live session must not be forced idle by a disk merge. */
export function isLiveBusyStatus(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "awaiting_permission" || status === "awaiting_input";
}

/**
 * Merge offline disk history with any live-only blocks still on the session.
 * Preserves busy turn status so a late disk scan cannot unlock send mid-turn.
 */
export function mergeOfflineWithLive(pending: Session, cur: Session | undefined): Session {
  const busyStatus = cur && isLiveBusyStatus(cur.status) ? cur.status : null;
  const status = busyStatus ?? ("idle" as const);

  if (!cur || cur.blocks.length === 0) {
    return { ...pending, status };
  }
  // Live longer than offline: keep live (already has the offline prefix + turn).
  if (cur.blocks.length > pending.blocks.length) {
    return { ...cur, status };
  }
  const pendingIds = new Set(pending.blocks.map((b) => b.id));
  const liveOnly = cur.blocks.filter((b) => !pendingIds.has(b.id));
  if (liveOnly.length === 0) {
    return { ...pending, status, usage: cur.usage?.outputTokens ? cur.usage : pending.usage };
  }
  return {
    ...pending,
    status,
    blocks: [...pending.blocks, ...liveOnly],
    usage: cur.usage?.outputTokens ? cur.usage : pending.usage,
  };
}

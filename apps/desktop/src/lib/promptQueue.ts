/** Pure helpers for prompt-queue merge / drain (unit-testable). */

export type QueueEntryLike = {
  id: string;
  text?: string;
  state: "queued" | "interjected" | "sending";
  source?: "local" | "cli";
};

/** Normalize operator text for ghost / duplicate matching. */
export function normalizeQueueText(text: string | undefined | null): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Merge CLI-authoritative queue with local-only entries the CLI has not yet
 * acknowledged. Prevents x.ai/queue/changed from wiping in-flight local
 * enqueues (race: FE adds local → CLI snapshot arrives before our promptId).
 */
export function mergeCliQueueWithLocal<T extends QueueEntryLike>(
  cliEntries: T[],
  previous: T[],
): T[] {
  const cliIds = new Set(cliEntries.map((item) => item.id));
  const localOnly = previous.filter(
    (item) => item.source !== "cli" && !cliIds.has(item.id),
  );
  const interjectedLocal = localOnly.filter((item) => item.state === "interjected");
  const otherLocal = localOnly.filter((item) => item.state !== "interjected");
  // Interjected locals first (drain priority), then CLI order, then other locals.
  return [...interjectedLocal, ...cliEntries, ...otherLocal];
}

/**
 * Index of the next *local* entry to drain when the session is idle.
 * Array order is authoritative (matches drag-reorder). Interject actions pin
 * to the head when created; later drag can demote them.
 */
export function nextLocalDrainIndex(queue: readonly QueueEntryLike[]): number {
  return queue.findIndex((item) => item.source !== "cli" && item.state !== "sending");
}

/** Drop rows whose text matches the live turn's primary user bubble. */
export function filterQueueGhostsByLiveText<T extends { text?: string }>(
  queue: readonly T[],
  liveUserText: string | null | undefined,
): T[] {
  const live = normalizeQueueText(liveUserText);
  if (!live || queue.length === 0) return [...queue];
  return queue.filter((item) => normalizeQueueText(item.text) !== live);
}

/**
 * Drop rows whose text matches any user bubble in the live turn
 * (primary + mid-turn interjections).
 */
export function filterQueueGhostsByLiveTexts<T extends { text?: string }>(
  queue: readonly T[],
  liveUserTexts: readonly string[],
): T[] {
  if (queue.length === 0 || liveUserTexts.length === 0) return [...queue];
  const live = new Set(liveUserTexts.map((t) => normalizeQueueText(t)).filter(Boolean));
  if (live.size === 0) return [...queue];
  return queue.filter((item) => !live.has(normalizeQueueText(item.text)));
}

/**
 * Drop rows already written via concurrent session/prompt (CLI may still echo
 * them in x.ai/queue/changed — that is a ghost 已入队, not a waiting follow-up).
 */
export function filterConsumedQueueEntries<T extends { id: string; text?: string }>(
  queue: readonly T[],
  consumedIds: ReadonlySet<string> | undefined | null,
  consumedTexts?: ReadonlySet<string> | undefined | null,
): T[] {
  if (queue.length === 0) return [...queue];
  const hasIds = Boolean(consumedIds && consumedIds.size > 0);
  const hasTexts = Boolean(consumedTexts && consumedTexts.size > 0);
  if (!hasIds && !hasTexts) return [...queue];
  return queue.filter((item) => {
    if (hasIds && consumedIds!.has(item.id)) return false;
    if (hasTexts) {
      const t = normalizeQueueText(item.text);
      if (t && consumedTexts!.has(t)) return false;
    }
    return true;
  });
}

/**
 * Operator-visible queue while a turn is live.
 * - Hide CLI echoes (concurrent session/prompt already on the wire).
 * - Hide rows already consumed by id or text.
 * Local rows still waiting for a wire write remain visible.
 */
export function filterBusyTurnQueueEntries<T extends QueueEntryLike & { text?: string }>(
  queue: readonly T[],
  opts: {
    consumedIds?: ReadonlySet<string> | null;
    consumedTexts?: ReadonlySet<string> | null;
  } = {},
): T[] {
  const withoutCli = queue.filter((item) => item.source !== "cli");
  return filterConsumedQueueEntries(withoutCli, opts.consumedIds, opts.consumedTexts);
}

/** When the session is idle, CLI-owned rows are stale ghosts — keep only local. */
export function stripCliOwnedEntries<T extends QueueEntryLike>(queue: readonly T[]): T[] {
  return queue.filter((item) => item.source !== "cli");
}

/**
 * True if the queue already holds the same operator text (prevents double-Enter
 * stacking identical follow-ups while busy).
 */
export function queueHasSameText(
  queue: readonly { text?: string }[],
  text: string,
): boolean {
  const needle = normalizeQueueText(text);
  if (!needle) return false;
  return queue.some((item) => normalizeQueueText(item.text) === needle);
}

/** Pure helpers for prompt-queue merge / drain (unit-testable). */

export type QueueEntryLike = {
  id: string;
  state: "queued" | "interjected" | "sending";
  source?: "local" | "cli";
};

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
 * Prefer interjected, then first non-sending local-owned row.
 */
export function nextLocalDrainIndex(queue: readonly QueueEntryLike[]): number {
  const interjected = queue.findIndex(
    (item) => item.source !== "cli" && item.state === "interjected",
  );
  if (interjected >= 0) return interjected;
  return queue.findIndex((item) => item.source !== "cli" && item.state !== "sending");
}

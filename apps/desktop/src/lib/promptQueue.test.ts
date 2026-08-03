import { describe, expect, it } from "vitest";
import {
  filterBusyTurnQueueEntries,
  filterConsumedQueueEntries,
  filterQueueGhostsByLiveText,
  filterQueueGhostsByLiveTexts,
  mergeCliQueueWithLocal,
  nextLocalDrainIndex,
  normalizeQueueText,
  queueHasSameText,
  stripCliOwnedEntries,
  type QueueEntryLike,
} from "./promptQueue";

describe("mergeCliQueueWithLocal", () => {
  it("preserves local-only entries not in CLI snapshot", () => {
    const previous: QueueEntryLike[] = [
      { id: "local-1", state: "queued", source: "local" },
      { id: "cli-1", state: "queued", source: "cli" },
    ];
    const cli: QueueEntryLike[] = [{ id: "cli-1", state: "sending", source: "cli" }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged.map((e) => e.id)).toEqual(["cli-1", "local-1"]);
    expect(merged.find((e) => e.id === "local-1")?.source).toBe("local");
  });

  it("puts interjected locals first", () => {
    const previous: QueueEntryLike[] = [
      { id: "local-q", state: "queued", source: "local" },
      { id: "local-i", state: "interjected", source: "local" },
    ];
    const cli: QueueEntryLike[] = [{ id: "cli-1", state: "queued", source: "cli" }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged.map((e) => e.id)).toEqual(["local-i", "cli-1", "local-q"]);
  });

  it("drops local when CLI has the same id", () => {
    const previous: QueueEntryLike[] = [{ id: "a", state: "queued", source: "local" }];
    const cli: QueueEntryLike[] = [{ id: "a", state: "queued", source: "cli" }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("cli");
  });
});

describe("nextLocalDrainIndex", () => {
  it("respects array order (drag-reorder is authoritative)", () => {
    const queue: QueueEntryLike[] = [
      { id: "q1", state: "queued", source: "local" },
      { id: "i1", state: "interjected", source: "local" },
      { id: "c1", state: "queued", source: "cli" },
    ];
    // First local non-sending — even if a later row is interjected.
    expect(nextLocalDrainIndex(queue)).toBe(0);
  });

  it("skips cli and sending entries", () => {
    const queue: QueueEntryLike[] = [
      { id: "c1", state: "queued", source: "cli" },
      { id: "s1", state: "sending", source: "local" },
      { id: "q1", state: "queued", source: "local" },
    ];
    expect(nextLocalDrainIndex(queue)).toBe(2);
  });

  it("returns -1 when only cli remains", () => {
    const queue: QueueEntryLike[] = [{ id: "c1", state: "queued", source: "cli" }];
    expect(nextLocalDrainIndex(queue)).toBe(-1);
  });

  it("picks interjected when it is first in array", () => {
    const queue: QueueEntryLike[] = [
      { id: "i1", state: "interjected", source: "local" },
      { id: "q1", state: "queued", source: "local" },
    ];
    expect(nextLocalDrainIndex(queue)).toBe(0);
  });
});

describe("filterQueueGhostsByLiveText", () => {
  it("removes rows matching the live user bubble", () => {
    const queue = [
      { id: "1", text: "hello" },
      { id: "2", text: "other" },
      { id: "3", text: "  hello  " },
    ];
    expect(filterQueueGhostsByLiveText(queue, "hello").map((e) => e.id)).toEqual(["2"]);
  });

  it("is a no-op without live text", () => {
    const queue = [{ id: "1", text: "hello" }];
    expect(filterQueueGhostsByLiveText(queue, null)).toHaveLength(1);
  });
});

describe("filterQueueGhostsByLiveTexts", () => {
  it("removes rows matching any live-turn user text (primary + interject)", () => {
    const queue = [
      { id: "1", text: "primary" },
      { id: "2", text: "follow-up" },
      { id: "3", text: "interject" },
    ];
    expect(
      filterQueueGhostsByLiveTexts(queue, ["primary", "interject"]).map((e) => e.id),
    ).toEqual(["2"]);
  });
});

describe("filterConsumedQueueEntries", () => {
  it("drops ids already written via concurrent session/prompt", () => {
    const queue = [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ];
    expect(filterConsumedQueueEntries(queue, new Set(["a"])).map((e) => e.id)).toEqual(["b"]);
  });

  it("drops by normalized text when CLI reuses a different id", () => {
    const queue = [
      { id: "cli-new", text: "  go dig  " },
      { id: "keep", text: "other" },
    ];
    expect(
      filterConsumedQueueEntries(queue, null, new Set([normalizeQueueText("go dig")])).map(
        (e) => e.id,
      ),
    ).toEqual(["keep"]);
  });

  it("is a no-op with empty consumed set", () => {
    const queue = [{ id: "a", text: "one" }];
    expect(filterConsumedQueueEntries(queue, new Set())).toHaveLength(1);
    expect(filterConsumedQueueEntries(queue, null)).toHaveLength(1);
  });
});

describe("filterBusyTurnQueueEntries", () => {
  it("hides CLI echoes and consumed concurrent texts during a live turn", () => {
    const queue: (QueueEntryLike & { text?: string })[] = [
      { id: "cli-1", state: "queued", source: "cli", text: "old concurrent" },
      { id: "local-pending", state: "queued", source: "local", text: "still waiting" },
      { id: "local-done", state: "queued", source: "local", text: "already sent" },
    ];
    const next = filterBusyTurnQueueEntries(queue, {
      consumedIds: new Set(["local-done"]),
      consumedTexts: new Set([normalizeQueueText("already sent")]),
    });
    expect(next.map((e) => e.id)).toEqual(["local-pending"]);
  });
});

describe("stripCliOwnedEntries", () => {
  it("keeps only non-cli rows", () => {
    const queue: QueueEntryLike[] = [
      { id: "c", state: "queued", source: "cli" },
      { id: "l", state: "queued", source: "local" },
      { id: "u", state: "queued" },
    ];
    expect(stripCliOwnedEntries(queue).map((e) => e.id)).toEqual(["l", "u"]);
  });
});

describe("queueHasSameText", () => {
  it("detects duplicate operator text", () => {
    expect(queueHasSameText([{ text: "a" }, { text: " b " }], "b")).toBe(true);
    expect(queueHasSameText([{ text: "a" }], "b")).toBe(false);
  });
});

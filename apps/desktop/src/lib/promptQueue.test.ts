import { describe, expect, it } from "vitest";
import {
  mergeCliQueueWithLocal,
  nextLocalDrainIndex,
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
  it("prefers interjected over earlier queued local", () => {
    const queue: QueueEntryLike[] = [
      { id: "q1", state: "queued", source: "local" },
      { id: "i1", state: "interjected", source: "local" },
      { id: "c1", state: "queued", source: "cli" },
    ];
    expect(nextLocalDrainIndex(queue)).toBe(1);
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
});

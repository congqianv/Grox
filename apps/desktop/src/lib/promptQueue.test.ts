import { describe, expect, it } from "vitest";
import { mergeCliQueueWithLocal, nextLocalDrainIndex } from "./promptQueue";

describe("mergeCliQueueWithLocal", () => {
  it("preserves local-only entries not in CLI snapshot", () => {
    const previous = [
      { id: "local-1", state: "queued" as const, source: "local" as const },
      { id: "cli-1", state: "queued" as const, source: "cli" as const },
    ];
    const cli = [{ id: "cli-1", state: "sending" as const, source: "cli" as const }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged.map((e) => e.id)).toEqual(["cli-1", "local-1"]);
    expect(merged.find((e) => e.id === "local-1")?.source).toBe("local");
  });

  it("puts interjected locals first", () => {
    const previous = [
      { id: "local-q", state: "queued" as const, source: "local" as const },
      { id: "local-i", state: "interjected" as const, source: "local" as const },
    ];
    const cli = [{ id: "cli-1", state: "queued" as const, source: "cli" as const }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged.map((e) => e.id)).toEqual(["local-i", "cli-1", "local-q"]);
  });

  it("drops local when CLI has the same id", () => {
    const previous = [{ id: "a", state: "queued" as const, source: "local" as const }];
    const cli = [{ id: "a", state: "queued" as const, source: "cli" as const }];
    const merged = mergeCliQueueWithLocal(cli, previous);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("cli");
  });
});

describe("nextLocalDrainIndex", () => {
  it("prefers interjected over earlier queued local", () => {
    const queue = [
      { id: "q1", state: "queued" as const, source: "local" as const },
      { id: "i1", state: "interjected" as const, source: "local" as const },
      { id: "c1", state: "queued" as const, source: "cli" as const },
    ];
    expect(nextLocalDrainIndex(queue)).toBe(1);
  });

  it("skips cli and sending entries", () => {
    const queue = [
      { id: "c1", state: "queued" as const, source: "cli" as const },
      { id: "s1", state: "sending" as const, source: "local" as const },
      { id: "q1", state: "queued" as const, source: "local" as const },
    ];
    expect(nextLocalDrainIndex(queue)).toBe(2);
  });

  it("returns -1 when only cli remains", () => {
    expect(
      nextLocalDrainIndex([{ id: "c1", state: "queued" as const, source: "cli" as const }]),
    ).toBe(-1);
  });
});

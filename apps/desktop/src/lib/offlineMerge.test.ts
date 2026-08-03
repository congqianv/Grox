import { describe, expect, it } from "vitest";
import { blockContentKey, mergeOfflineWithLive } from "./offlineMerge";
import type { Session } from "../bridge/types";

function sess(
  partial: Partial<Session> & Pick<Session, "id" | "blocks" | "status">,
): Session {
  return {
    cwd: "C:\\proj",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    model: "test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      contextUsed: 0,
      contextMax: 0,
      turns: 0,
    },
    ...partial,
  };
}

describe("mergeOfflineWithLive", () => {
  it("keeps offline when live is empty", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const out = mergeOfflineWithLive(pending, undefined);
    expect(out.blocks).toHaveLength(1);
    expect(out.status).toBe("idle");
  });

  it("appends live-only blocks after offline prefix", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "u1", text: "hi", ts: 1 },
        { type: "user", id: "u2", text: "new", ts: 2 },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.blocks.map((b) => b.id)).toEqual(["u1", "u2"]);
  });

  it("does not force idle while live turn is busy", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const cur = sess({
      id: "a",
      status: "running",
      blocks: [
        { type: "user", id: "u1", text: "hi", ts: 1 },
        { type: "assistant", id: "a1", text: "…", streaming: true, ts: 2 },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.status).toBe("running");
    expect(out.blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves awaiting_permission when disk is longer", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "u1", text: "hi", ts: 1 },
        { type: "user", id: "u2", text: "more", ts: 2 },
      ],
    });
    const cur = sess({
      id: "a",
      status: "awaiting_permission",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.status).toBe("awaiting_permission");
  });

  it("does not duplicate when offline and live use different ids for same content", () => {
    // Disk scan uses stable ids; UI painted optimistic UUIDs for the same turns.
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "disk-u1", text: "hello world", ts: 1 },
        { type: "assistant", id: "disk-a1", text: "hi there", ts: 2, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "uuid-u1", text: "hello world", ts: 1 },
        { type: "assistant", id: "uuid-a1", text: "hi there", ts: 2, streaming: false },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks.map((b) => b.id)).toEqual(["disk-u1", "disk-a1"]);
  });

  it("appends only a new live user turn after offline prefix (content-aware)", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "disk-u1", text: "old", ts: 1 },
        { type: "assistant", id: "disk-a1", text: "reply", ts: 2, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "uuid-u1", text: "old", ts: 1 },
        { type: "assistant", id: "uuid-a1", text: "reply", ts: 2, streaming: false },
        { type: "user", id: "uuid-u2", text: "brand new", ts: 3 },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.blocks.map((b) => (b.type === "user" || b.type === "assistant" ? b.text : b.id))).toEqual([
      "old",
      "reply",
      "brand new",
    ]);
  });

  it("blockContentKey distinguishes interjected users", () => {
    const a = blockContentKey({ type: "user", id: "1", text: "x", ts: 1 });
    const b = blockContentKey({ type: "user", id: "2", text: "x", ts: 1, interjected: true });
    expect(a).not.toBe(b);
  });
});

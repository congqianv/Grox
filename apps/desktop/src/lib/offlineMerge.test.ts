import { describe, expect, it } from "vitest";
import { mergeOfflineWithLive } from "./offlineMerge";
import type { Session } from "../bridge/types";

function sess(
  partial: Partial<Session> & Pick<Session, "id" | "blocks" | "status">,
): Session {
  return {
    cwd: "C:\\proj",
    title: "t",
    createdAt: 0,
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
});

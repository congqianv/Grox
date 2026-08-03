import { describe, expect, it } from "vitest";
import type { SessionBlock } from "../../bridge/types";
import { groupTurns } from "./Timeline";

function user(id: string, text: string, interjected = false): SessionBlock {
  return { type: "user", id, text, ts: 1, ...(interjected ? { interjected: true } : {}) };
}

function assistant(id: string, text: string): SessionBlock {
  return { type: "assistant", id, text, ts: 1, streaming: true };
}

describe("groupTurns", () => {
  it("starts a new turn on normal user messages", () => {
    const turns = groupTurns([
      user("u1", "first"),
      assistant("a1", "reply"),
      user("u2", "second"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe("u1");
    expect(turns[0].promptIndex).toBe(0);
    expect(turns[1].id).toBe("u2");
    expect(turns[1].promptIndex).toBe(1);
  });

  it("keeps interjected users inside the live turn", () => {
    const turns = groupTurns([
      user("u1", "first"),
      assistant("a1", "working…"),
      user("inj", "please stop", true),
      assistant("a2", "ok"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe("u1");
    expect(turns[0].promptIndex).toBe(0);
    expect(turns[0].blocks.map((b) => b.id)).toEqual(["u1", "a1", "inj", "a2"]);
  });

  it("does not let a lone interjected user invent a turn without a parent", () => {
    // Edge: interject flag on first block still opens a turn (no parent to join).
    const turns = groupTurns([user("only", "hi", true)]);
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks).toHaveLength(1);
  });
});

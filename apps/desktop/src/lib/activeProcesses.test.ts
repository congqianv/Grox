import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import { extractActiveSubagents, extractRecentSubagents } from "./activeProcesses";

function sessionWithTools(calls: Array<{ id: string; status: "running" | "done" | "pending"; kind?: "task" | "read" }>): Session {
  return {
    id: "s1",
    title: "t",
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
    model: "m",
    blocks: calls.map((c, i) => ({
      type: "tool" as const,
      id: `b-${c.id}`,
      ts: i,
      call: {
        id: c.id,
        kind: c.kind ?? "task",
        title: `task ${c.id}`,
        status: c.status,
        startedAt: 1000 + i,
      },
    })),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      contextUsed: 0,
      contextMax: 0,
      turns: 0,
    },
    status: "running",
  };
}

describe("activeProcesses B1 helpers", () => {
  it("extracts active task subagents only", () => {
    const session = sessionWithTools([
      { id: "1", status: "running" },
      { id: "2", status: "done" },
      { id: "3", status: "running", kind: "read" },
    ]);
    const active = extractActiveSubagents(session);
    expect(active.map((a) => a.id)).toEqual(["1"]);
    expect(active[0].blockId).toBe("b-1");
  });

  it("extractRecentSubagents returns finished tasks newest first", () => {
    const session = sessionWithTools([
      { id: "old", status: "done" },
      { id: "live", status: "running" },
      { id: "new", status: "done" },
    ]);
    // startedAt increases with index — "new" is newest finished
    const recent = extractRecentSubagents(session, 8);
    expect(recent.map((a) => a.id)).toEqual(["new", "old"]);
  });
});

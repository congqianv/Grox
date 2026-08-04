import { describe, expect, it } from "vitest";
import type { Session, ToolCall, ToolKind, ToolStatus } from "../bridge/types";
import {
  extractActiveSubagents,
  extractRecentSubagents,
  isRealSubagentCall,
  isSubagentNoise,
} from "./activeProcesses";

function tool(
  partial: Partial<ToolCall> & { id: string; status: ToolStatus; kind?: ToolKind },
): ToolCall {
  return {
    id: partial.id,
    kind: partial.kind ?? "task",
    title: partial.title ?? `task ${partial.id}`,
    detail: partial.detail,
    status: partial.status,
    startedAt: partial.startedAt ?? 1000,
    rawKind: partial.rawKind,
    input: partial.input,
  };
}

function sessionWith(calls: ToolCall[]): Session {
  return {
    id: "s1",
    title: "t",
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
    model: "m",
    blocks: calls.map((call, i) => ({
      type: "tool" as const,
      id: `b-${call.id}`,
      ts: i,
      call: { ...call, startedAt: call.startedAt ?? 1000 + i },
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

describe("isSubagentNoise / isRealSubagentCall", () => {
  it("treats shell Task call-uuid as noise", () => {
    const call = tool({
      id: "1",
      status: "done",
      title: "Task call-c3817309-29fe-433c-b931-729875dfb0bb-4",
      detail: "1..30 | ForEach-Object { Write-Output }",
    });
    expect(isSubagentNoise(call)).toBe(true);
    expect(isRealSubagentCall(call)).toBe(false);
  });

  it("excludes get_command_or_subagent_output poll tools", () => {
    const call = tool({
      id: "2",
      status: "done",
      kind: "other",
      title: "get_command_or_subagent_output",
      rawKind: "get_command_or_subagent_output",
    });
    expect(isSubagentNoise(call)).toBe(true);
    expect(isRealSubagentCall(call)).toBe(false);
  });

  it("excludes Execute/Select-String shell and [bg] shells", () => {
    expect(
      isRealSubagentCall(
        tool({
          id: "ex",
          status: "done",
          kind: "execute",
          title: "Execute `Select-String -Path scripts\\v2\\ship-publish`",
        }),
      ),
    ).toBe(false);
    expect(
      isRealSubagentCall(
        tool({
          id: "bg",
          status: "done",
          title: "[bg] $ErrorActionPreference = 'Continue'",
        }),
      ),
    ).toBe(false);
  });

  it("accepts spawn_subagent / subagent_type and reviewer-style agents", () => {
    const call = tool({
      id: "3",
      status: "running",
      title: "spawn_subagent",
      input: '{"subagent_type":"explore","description":"scan auth"}',
    });
    expect(isRealSubagentCall(call)).toBe(true);
    expect(isSubagentNoise(call)).toBe(false);
    expect(
      isRealSubagentCall(
        tool({
          id: "rev",
          status: "done",
          kind: "task",
          title: "code-reviewer",
          detail: "Review deploy/ship recent diffs",
          input: '{"subagent_type":"code-reviewer"}',
        }),
      ),
    ).toBe(true);
  });

  it("does not treat ordinary task prose with plan/general as subagents", () => {
    expect(
      isRealSubagentCall(
        tool({
          id: "fp1",
          status: "running",
          kind: "task",
          title: "Task",
          detail: "Fix general bug in auth",
        }),
      ),
    ).toBe(false);
    expect(
      isRealSubagentCall(
        tool({
          id: "fp2",
          status: "running",
          kind: "task",
          title: "Implement plan for release",
          detail: "update docs",
        }),
      ),
    ).toBe(false);
  });

  it("keeps spawn_subagent even when kind is execute (strong signal wins)", () => {
    expect(
      isRealSubagentCall(
        tool({
          id: "fn1",
          status: "running",
          kind: "execute",
          title: "spawn_subagent",
          input: '{"subagent_type":"explore"}',
        }),
      ),
    ).toBe(true);
  });

  it("accepts structured explore · role prefix on task kind", () => {
    expect(
      isRealSubagentCall(
        tool({
          id: "role",
          status: "running",
          kind: "task",
          title: "Task call-uuid-here",
          detail: "explore · scan routes",
        }),
      ),
    ).toBe(true);
  });
});

describe("extractActiveSubagents / extractRecentSubagents", () => {
  it("does not list bare shell tasks as subagents", () => {
    const session = sessionWith([
      tool({
        id: "shell",
        status: "running",
        title: "Task call-aaaa-bbbb",
        detail: "echo hi",
      }),
      tool({ id: "read", status: "running", kind: "read", title: "read_file" }),
    ]);
    expect(extractActiveSubagents(session)).toEqual([]);
  });

  it("lists real explore subagent and prefers live over history noise", () => {
    const session = sessionWith([
      tool({
        id: "noise",
        status: "done",
        title: "get_command_or_subagent_output",
      }),
      tool({
        id: "agent",
        status: "running",
        title: "spawn_subagent",
        detail: "explore · scan routes",
        input: '{"subagent_type":"explore"}',
        startedAt: 5000,
      }),
      tool({
        id: "old",
        status: "done",
        title: "spawn_subagent",
        input: '{"subagent_type":"plan"}',
        startedAt: 1000,
      }),
    ]);
    const active = extractActiveSubagents(session);
    expect(active.map((a) => a.id)).toEqual(["agent"]);
    expect(active[0].agentType).toBe("explore");

    const recent = extractRecentSubagents(session, 8);
    expect(recent.map((a) => a.id)).toEqual(["old"]);
    expect(recent[0].agentType).toBe("plan");
  });
});

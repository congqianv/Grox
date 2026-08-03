/**
 * Executable smoke scenarios for 加入队列 / 插话 / 终止.
 * These are the three operator checks promised after H1–H4 / M1–M5.
 */
import { describe, expect, it } from "vitest";
import {
  classifyTurnStatus,
  composerAffordances,
  gateQueueDrainsOnlyOnIdle,
  nextDrainableIndex,
  resolveInterjectDedup,
  resolveInterjectPath,
  resolveSendPath,
  shouldDrainQueue,
} from "./queueTurnPolicy";
import { normalizeQueueText, stripCliOwnedEntries } from "./promptQueue";
import { statusAfterGateResolve } from "./sessionGate";
import type { SessionBlock } from "../bridge/types";

describe("smoke 1: busy 入队 → Stop → 队列保留且不自动发", () => {
  it("running shows queue + stop + interject; idle alone would drain", () => {
    expect(classifyTurnStatus("running")).toBe("running");
    expect(composerAffordances("running")).toEqual({
      showSend: false,
      showStop: true,
      showQueue: true,
      showInterject: true,
    });
    expect(resolveSendPath("running")).toBe("concurrent_queue");
  });

  it("after Stop: suppress blocks drain even when status is idle and local rows exist", () => {
    const queue = [
      { id: "a", state: "queued" as const, source: "local" as const, text: "follow-up dig" },
      { id: "b", state: "queued" as const, source: "local" as const, text: "another" },
    ];

    // Natural idle without Stop → would drain head.
    expect(
      shouldDrainQueue({
        status: "idle",
        suppressNextIdleDrain: false,
        queue,
      }),
    ).toBe(true);

    // Operator Stop: suppress stays until re-send / clear / reconnect.
    expect(
      shouldDrainQueue({
        status: "idle",
        suppressNextIdleDrain: true,
        queue,
      }),
    ).toBe(false);

    // Queue rows themselves are not stripped by Stop policy.
    expect(queue).toHaveLength(2);
  });

  it("does not drop sending/submitted rows when selecting drain head", () => {
    const queue = [
      { id: "sending-1", state: "sending" as const, source: "local" as const, text: "in flight" },
      { id: "sub-1", state: "queued" as const, source: "local" as const, text: "submitted" },
      { id: "ok", state: "queued" as const, source: "local" as const, text: "ready" },
    ];
    const submitted = new Set(["sub-1"]);
    // Must skip sending + submitted — not delete them (H3).
    expect(nextDrainableIndex(queue, submitted)).toBe(2);
    expect(queue.map((e) => e.id)).toEqual(["sending-1", "sub-1", "ok"]);
  });

  it("idle late CLI echo is stripped (M2) — not re-shown as 已入队", () => {
    const afterIdle = stripCliOwnedEntries([
      { id: "cli-ghost", state: "queued", source: "cli", text: "old concurrent" },
      { id: "local", state: "queued", source: "local", text: "parked after stop" },
    ]);
    expect(afterIdle.map((e) => e.id)).toEqual(["local"]);
  });
});

describe("smoke 2: 门禁入队 → 批准后 running → 仅 idle 才 drain", () => {
  const openPerm = (id: string): SessionBlock => ({
    type: "permission",
    id,
    req: {
      id: "r",
      toolCallId: id,
      title: "execute",
      description: "run",
      options: ["allow_once", "deny"],
    },
    ts: 1,
  });
  const resolvedPerm = (id: string): SessionBlock => {
    const base = openPerm(id);
    if (base.type !== "permission") throw new Error("expected permission");
    return { ...base, resolved: "allow_once" };
  };

  it("gated path is local_gate_queue and hides interject button", () => {
    expect(classifyTurnStatus("awaiting_permission")).toBe("gated");
    expect(classifyTurnStatus("awaiting_input")).toBe("gated");
    expect(resolveSendPath("gated")).toBe("local_gate_queue");
    expect(resolveInterjectPath("gated")).toBe("local_gate_queue");
    expect(composerAffordances("gated")).toEqual({
      showSend: false,
      showStop: true,
      showQueue: true,
      showInterject: false,
    });
  });

  it("resolving last permission goes to running, not idle — drain must wait", () => {
    const blocks = [resolvedPerm("p1")];
    const next = statusAfterGateResolve(blocks, "awaiting_permission");
    expect(next).toBe("running");
    // Policy: gate queue does not drain while still running.
    expect(gateQueueDrainsOnlyOnIdle(next)).toBe(false);
    expect(
      shouldDrainQueue({
        status: next,
        suppressNextIdleDrain: false,
        queue: [{ id: "q1", state: "queued", source: "local", text: "after allow" }],
      }),
    ).toBe(false);
  });

  it("only after turn settles to idle does gate queue become drainable", () => {
    expect(
      shouldDrainQueue({
        status: "idle",
        suppressNextIdleDrain: false,
        queue: [{ id: "q1", state: "queued", source: "local", text: "after allow" }],
      }),
    ).toBe(true);
  });

  it("Stop during gate still suppresses drain of parked local rows", () => {
    expect(
      shouldDrainQueue({
        status: "idle",
        suppressNextIdleDrain: true,
        queue: [{ id: "q1", state: "queued", source: "local", text: "typed while gated" }],
      }),
    ).toBe(false);
  });
});

describe("smoke 3: 同文先入队再插话 → 只插一次（不双发）", () => {
  it("running uses interject_rpc path", () => {
    expect(resolveInterjectPath("running")).toBe("interject_rpc");
  });

  it("same text already in queue → accept interject but drop queue copy", () => {
    const text = "重新定位清楚问题再处理";
    const result = resolveInterjectDedup({
      text,
      queue: [
        { text: "  重新定位清楚问题再处理  " },
        { text: "other" },
      ],
      liveTurnTexts: ["primary user bubble"],
    });
    expect(result).toEqual({ action: "accept", dropQueueText: true });
  });

  it("same text already live (user bubble / prior interject) → reject", () => {
    const text = "重新定位清楚问题再处理";
    expect(
      resolveInterjectDedup({
        text,
        queue: [],
        liveTurnTexts: [text],
      }),
    ).toEqual({ action: "reject", reason: "live" });
  });

  it("same text already concurrent-consumed → reject (no double wire)", () => {
    const text = "你先启动子代理严格深挖";
    const consumed = new Set([normalizeQueueText(text)]);
    expect(
      resolveInterjectDedup({
        text,
        queue: [],
        liveTurnTexts: ["primary"],
        consumedTexts: consumed,
      }),
    ).toEqual({ action: "reject", reason: "consumed" });
  });

  it("whitespace-normalized equality matches M5 normalize policy", () => {
    const result = resolveInterjectDedup({
      text: "hello   world",
      queue: [{ text: "hello world" }],
      liveTurnTexts: [],
    });
    expect(result).toEqual({ action: "accept", dropQueueText: true });
  });
});

describe("composer affordance matrix (status → buttons)", () => {
  it("idle: only send", () => {
    expect(composerAffordances(classifyTurnStatus("idle")).showSend).toBe(true);
  });
  it("running: stop + queue + interject", () => {
    const a = composerAffordances(classifyTurnStatus("running"));
    expect(a.showStop && a.showQueue && a.showInterject).toBe(true);
  });
  it("gated: stop + queue, no interject", () => {
    const a = composerAffordances(classifyTurnStatus("awaiting_permission"));
    expect(a.showInterject).toBe(false);
    expect(a.showQueue && a.showStop).toBe(true);
  });
});

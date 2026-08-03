import { describe, it, expect } from "vitest";
import {
  isInsideWorkspace,
  isMutatingKind,
  isReadOnlyCommand,
  isPlanFileWrite,
  pickRejectOption,
  shouldBlockWrite,
  shouldBlockTerminal,
  shouldRejectPermission,
  type PlanGateContext,
} from "./planGate";

const WIN_ROOT = "C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W";
const WIN_WORKSPACE_WRITE =
  "\\\\?\\C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W\\app.js";
const WIN_PLAN_FILE =
  "\\\\?\\C:\\Users\\Dell\\.grok\\sessions\\C%3A%5CUsers%5CDell%5CAppData%5CLocal%5CTemp%5Cgrok-plan-exp-GyuZ1W\\019e6b7e\\plan.md";

const active = (root: string, grokHome?: string): PlanGateContext => ({
  active: true,
  workspaceRoot: root,
  grokHome,
});
const off = (root: string): PlanGateContext => ({ active: false, workspaceRoot: root });

describe("isInsideWorkspace", () => {
  it("treats a write inside the workspace as inside — even with the \\\\?\\ long-path prefix", () => {
    expect(isInsideWorkspace(WIN_WORKSPACE_WRITE, WIN_ROOT)).toBe(true);
  });
  it("treats grok's own ~/.grok/.../plan.md as OUTSIDE the workspace", () => {
    expect(isInsideWorkspace(WIN_PLAN_FILE, WIN_ROOT)).toBe(false);
  });
  it("is case-insensitive for Windows drive paths", () => {
    expect(isInsideWorkspace("c:\\Proj\\src\\a.ts", "C:\\proj")).toBe(true);
  });
  it("is case-sensitive for POSIX paths", () => {
    expect(isInsideWorkspace("/Work/src/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/src/a.ts", "/work")).toBe(true);
  });
  it("does not treat a sibling dir with a shared prefix as inside", () => {
    expect(isInsideWorkspace("/work2/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("C:\\proj-other\\a.ts", "C:\\proj")).toBe(false);
  });
  it("resolves .. traversal that escapes the workspace as outside", () => {
    expect(isInsideWorkspace("/work/../etc/passwd", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/sub/../keep.ts", "/work")).toBe(true);
  });
});

describe("shouldBlockWrite", () => {
  it("blocks a workspace write while planning", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, active(WIN_ROOT))).toBe(true);
  });
  it("allows grok writing its own plan.md while planning", () => {
    expect(shouldBlockWrite(WIN_PLAN_FILE, active(WIN_ROOT, "C:\\Users\\Dell\\.grok"))).toBe(
      false,
    );
  });
  it("allows any write when the gate is off", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, off(WIN_ROOT))).toBe(false);
  });
  it("allows a scratch write to /tmp while planning", () => {
    expect(shouldBlockWrite("/tmp/scratch.txt", active("/home/u/proj"))).toBe(false);
  });
});

describe("isReadOnlyCommand / shouldBlockTerminal", () => {
  it("allows common read-only exploration", () => {
    expect(isReadOnlyCommand("ls -la")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
    expect(isReadOnlyCommand("git diff --stat")).toBe(true);
    expect(shouldBlockTerminal("ls", active("/w"))).toBe(false);
  });
  it("blocks mutating shells while planning", () => {
    expect(isReadOnlyCommand("rm -rf /tmp/x")).toBe(false);
    expect(isReadOnlyCommand("echo hi > file")).toBe(false);
    expect(shouldBlockTerminal("rm -rf node_modules", active("/w"))).toBe(true);
  });
  it("blocks git branch create but allows git branch -a", () => {
    expect(isReadOnlyCommand("git branch -a")).toBe(true);
    expect(isReadOnlyCommand("git branch new-feature")).toBe(false);
  });
});

describe("shouldRejectPermission / pickRejectOption", () => {
  it("rejects mutating kinds while plan active", () => {
    expect(shouldRejectPermission("edit", active("/w"))).toBe(true);
    expect(shouldRejectPermission("execute", active("/w"))).toBe(true);
    expect(shouldRejectPermission("read", active("/w"))).toBe(false);
    expect(shouldRejectPermission("edit", off("/w"))).toBe(false);
  });
  it("isMutatingKind covers write tools", () => {
    expect(isMutatingKind("write")).toBe(true);
    expect(isMutatingKind("READ")).toBe(false);
  });
  it("pickRejectOption prefers reject_once", () => {
    expect(
      pickRejectOption([
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ]),
    ).toBe("r");
    expect(pickRejectOption([{ optionId: "d", kind: "deny" }])).toBe("d");
  });
  it("isPlanFileWrite matches session plan.md", () => {
    expect(isPlanFileWrite(WIN_PLAN_FILE)).toBe(true);
    expect(isPlanFileWrite("/tmp/foo.md")).toBe(false);
  });
});

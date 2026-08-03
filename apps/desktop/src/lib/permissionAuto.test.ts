import { describe, expect, it } from "vitest";
import {
  permissionToolLabel,
  pickSilentAllowOptionId,
  shouldAutoApproveToolPermission,
} from "./permissionAuto";

describe("shouldAutoApproveToolPermission", () => {
  it("bypass still auto-approves when a manual gate is already open", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "bypass",
        toolLabel: "execute bash",
        computerUseAuto: false,
        hasOpenManualGate: true,
      }),
    ).toBe(true);
  });

  it("default mode never auto (except CU handled separately via computerUseAuto)", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "default",
        toolLabel: "read_file",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
  });

  it("bypass auto-approves tools when no gate is open", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "bypass",
        toolLabel: "bash",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(true);
  });

  it("auto mode allows safe tools only", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "read_file src/a.ts",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "execute npm test",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "write_file",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
  });

  it("auto mode still silent-allows safe tools while an execute card is open", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "read_file",
        computerUseAuto: false,
        hasOpenManualGate: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "execute bash",
        computerUseAuto: false,
        hasOpenManualGate: true,
      }),
    ).toBe(false);
  });

  it("auto mode covers expanded read/search/browse kinds (lower gate)", () => {
    for (const label of [
      "semantic_search",
      "codebase_search",
      "list_dir apps",
      "glob **/*.ts",
      "web_fetch https://example.com",
      "open_page",
      "definition Foo",
      "hover",
      "typecheck",
      "lint",
      "get_file_content",
    ]) {
      expect(
        shouldAutoApproveToolPermission({
          permissionMode: "auto",
          toolLabel: label,
          computerUseAuto: false,
          hasOpenManualGate: false,
        }),
        label,
      ).toBe(true);
    }
  });

  it("auto mode never auto-approves subagent spawn or media gen", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "spawn_subagent explore",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "image_gen banner",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "auto",
        toolLabel: "video_gen clip",
        computerUseAuto: false,
        hasOpenManualGate: false,
      }),
    ).toBe(false);
  });

  it("computerUseAuto allows CU tools", () => {
    expect(
      shouldAutoApproveToolPermission({
        permissionMode: "default",
        toolLabel: "grok_desktop_computer__click",
        computerUseAuto: true,
        hasOpenManualGate: false,
      }),
    ).toBe(true);
  });
});

describe("pickSilentAllowOptionId", () => {
  it("prefers allow_once over allow_always (no sticky always)", () => {
    expect(
      pickSilentAllowOptionId({
        allow_once: "once-id",
        allow_always: "always-id",
      }),
    ).toBe("once-id");
  });

  it("falls back to allow_always when once is missing", () => {
    expect(pickSilentAllowOptionId({ allow_always: "always-id" })).toBe("always-id");
  });
});

describe("permissionToolLabel", () => {
  it("joins string fields", () => {
    expect(permissionToolLabel({ title: "read", kind: "read", name: "x" })).toBe("read read x");
  });
});

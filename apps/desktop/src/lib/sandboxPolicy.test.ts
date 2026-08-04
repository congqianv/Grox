import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_PREFERENCE,
  readStoredSandboxPreference,
  resolveSandboxSpawn,
  sandboxSpawnArg,
  shouldRestartAgentForSandbox,
} from "./sandboxPolicy";

describe("resolveSandboxSpawn", () => {
  it("follow_cli injects nothing (open default / I-08 main path)", () => {
    const plan = resolveSandboxSpawn("follow_cli");
    expect(plan.explicit).toBe(false);
    expect(plan.profile).toBeNull();
    expect(plan.env).toEqual({});
    expect(plan.args).toEqual([]);
  });

  it("explicit workspace sets GROK_SANDBOX and --sandbox", () => {
    const plan = resolveSandboxSpawn("workspace");
    expect(plan.explicit).toBe(true);
    expect(plan.profile).toBe("workspace");
    expect(plan.env.GROK_SANDBOX).toBe("workspace");
    expect(plan.args).toEqual(["--sandbox", "workspace"]);
  });

  it("explicit read_only and off map to CLI profile tokens", () => {
    expect(resolveSandboxSpawn("read_only").profile).toBe("read-only");
    expect(resolveSandboxSpawn("off").env.GROK_SANDBOX).toBe("off");
  });
});

describe("readStoredSandboxPreference", () => {
  it("defaults to follow_cli and never forces sandbox", () => {
    expect(DEFAULT_SANDBOX_PREFERENCE).toBe("follow_cli");
    expect(readStoredSandboxPreference(() => null)).toBe("follow_cli");
    expect(readStoredSandboxPreference(() => "garbage")).toBe("follow_cli");
    expect(readStoredSandboxPreference(() => "workspace")).toBe("workspace");
  });
});

describe("sandboxSpawnArg + busy defer (I-03 / I-08)", () => {
  it("desktop agent spawn never injects sandbox (avoids model API 403)", () => {
    expect(sandboxSpawnArg(false, "workspace")).toBeNull();
    expect(sandboxSpawnArg(true, "follow_cli")).toBeNull();
    // Explicit workspace is UI-only until upstream supports agent-safe isolation
    expect(sandboxSpawnArg(true, "workspace")).toBeNull();
    expect(sandboxSpawnArg(true, "read_only")).toBeNull();
  });

  it("never auto-restarts — always defer so spawn/reconnect applies cleanly", () => {
    expect(
      shouldRestartAgentForSandbox(true, true, "follow_cli", "workspace"),
    ).toBe("defer_busy");
    expect(
      shouldRestartAgentForSandbox(false, true, "follow_cli", "workspace"),
    ).toBe("defer_busy");
    expect(
      shouldRestartAgentForSandbox(false, false, "follow_cli", "workspace"),
    ).toBe("noop");
  });

  it("same preference is noop (no thrash restart)", () => {
    expect(
      shouldRestartAgentForSandbox(false, true, "workspace", "workspace"),
    ).toBe("noop");
  });
});

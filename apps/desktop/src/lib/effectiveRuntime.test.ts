import { describe, expect, it } from "vitest";
import {
  buildEffectiveRuntimeSnapshot,
  isolationDisplay,
  isolationLabelText,
  type DualStateField,
} from "./effectiveRuntime";
import type { SandboxPreference } from "./sandboxPolicy";

const dual = (
  requested: SandboxPreference,
  applied: DualStateField<SandboxPreference>["applied"],
): DualStateField<SandboxPreference> => ({ requested, applied });

describe("isolationDisplay honesty", () => {
  it("never shows ok/isolated when applied is unknown (no fake green)", () => {
    const follow = isolationDisplay(dual("follow_cli", { kind: "unknown" }));
    expect(follow.tone).not.toBe("ok");
    expect(follow.labelKey).toBe("follow_cli");

    const requested = isolationDisplay(dual("workspace", { kind: "unknown" }));
    expect(requested.tone).not.toBe("ok");
    expect(requested.labelKey).toBe("requested_only");
    expect(isolationLabelText(requested, false)).toMatch(/not confirmed/i);
  });

  it("shows isolated only when applied is known sandbox profile", () => {
    const known = isolationDisplay(
      dual("workspace", { kind: "known", value: "workspace" }),
    );
    expect(known).toEqual({
      tone: "ok",
      labelKey: "isolated",
      sandbox: "workspace",
    });
  });

  it("warns on sandbox off without blocking", () => {
    const off = isolationDisplay(dual("off", { kind: "known", value: "off" }));
    expect(off.tone).toBe("warn");
    expect(off.labelKey).toBe("sandbox_off");
  });
});

describe("buildEffectiveRuntimeSnapshot", () => {
  it("defaults applied sides to unknown when inspect silent", () => {
    const snap = buildEffectiveRuntimeSnapshot({
      permissionRequested: "auto",
      sandboxRequested: "follow_cli",
      cwd: "C:/proj",
      computerUseOptIn: false,
      features: { sandboxUi: false, worktreeUi: false, effectivePanel: true },
    });
    expect(snap.permission.requested).toBe("auto");
    expect(snap.permission.applied.kind).toBe("unknown");
    expect(snap.sandbox.applied.kind).toBe("unknown");
    expect(snap.isolation.tone).not.toBe("ok");
    expect(snap.inspect.status).toBe("unavailable");
  });
});

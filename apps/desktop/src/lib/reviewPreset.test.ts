import { describe, expect, it } from "vitest";
import { reviewPreset, reviewPresetLabel } from "./reviewPreset";

describe("reviewPreset", () => {
  it("readonly is confirm + ask + read_only sandbox request", () => {
    const p = reviewPreset(false);
    expect(p.mode).toBe("ask");
    expect(p.permissionMode).toBe("default");
    expect(p.sandboxPreference).toBe("read_only");
    expect(reviewPresetLabel(p, false)).toMatch(/read-only/i);
  });

  it("allow edits is agent + auto + workspace (switchable, not forced)", () => {
    const p = reviewPreset(true);
    expect(p.mode).toBe("agent");
    expect(p.permissionMode).toBe("auto");
    expect(p.sandboxPreference).toBe("workspace");
  });
});

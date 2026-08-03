import { describe, expect, it } from "vitest";
import {
  SHARED_INIT_TIMEOUT_MS,
  bootFallbackNoticeText,
  bootPhaseLabel,
} from "./bootPhase";

describe("bootPhase", () => {
  it("keeps shared init timeout in the 12–15s design window", () => {
    expect(SHARED_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
    expect(SHARED_INIT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("labels connecting splash phases in Chinese and English", () => {
    expect(bootPhaseLabel("preflight", true)).toContain("预检");
    expect(bootPhaseLabel("initializing_shared", true)).toContain("共享");
    expect(bootPhaseLabel("fallback_local", true)).toContain("独立");
    expect(bootPhaseLabel("initializing_shared", false).toLowerCase()).toContain("shared");
    expect(bootPhaseLabel(null, true)).toContain("连接");
  });

  it("builds sticky local fallback notice with optional reason", () => {
    const zh = bootFallbackNoticeText(true, "timeout");
    expect(zh).toContain("独立进程");
    expect(zh).toContain("timeout");
    const en = bootFallbackNoticeText(false);
    expect(en.toLowerCase()).toContain("local");
  });
});

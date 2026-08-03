import { describe, expect, it } from "vitest";
import {
  SHARED_COLD_INIT_TIMEOUT_MS,
  SHARED_WARM_INIT_TIMEOUT_MS,
  bootFallbackNoticeText,
  bootPhaseLabel,
  sharedInitTimeoutMs,
} from "./bootPhase";

describe("bootPhase", () => {
  it("uses warm vs cold shared budgets", () => {
    expect(SHARED_WARM_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
    expect(SHARED_WARM_INIT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(SHARED_COLD_INIT_TIMEOUT_MS).toBeGreaterThan(SHARED_WARM_INIT_TIMEOUT_MS);
    expect(sharedInitTimeoutMs(true)).toBe(SHARED_WARM_INIT_TIMEOUT_MS);
    expect(sharedInitTimeoutMs(false)).toBe(SHARED_COLD_INIT_TIMEOUT_MS);
    expect(sharedInitTimeoutMs(undefined)).toBe(SHARED_COLD_INIT_TIMEOUT_MS);
  });

  it("labels connecting splash phases in Chinese and English", () => {
    expect(bootPhaseLabel("preflight", true)).toContain("预检");
    expect(bootPhaseLabel("initializing_shared", true)).toContain("共享");
    expect(bootPhaseLabel("fallback_local", true)).toContain("独立");
    expect(bootPhaseLabel("initializing_shared", false).toLowerCase()).toContain("shared");
    expect(bootPhaseLabel(null, true)).toContain("连接");
  });

  it("builds soft local fallback notice without forcing reconnect language", () => {
    const zh = bootFallbackNoticeText(true, "timeout");
    expect(zh).toContain("独立进程");
    expect(zh).toContain("timeout");
    // Must not match StatusBar reconnect heuristic (`Agent` / 重连 / 崩溃).
    expect(zh).not.toMatch(/Agent|重连|崩溃|退出/);
    const en = bootFallbackNoticeText(false);
    expect(en.toLowerCase()).toContain("local");
    expect(en).not.toMatch(/\bAgent\b/);
  });
});

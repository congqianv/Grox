import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_STORAGE_KEY,
  isFeatureEnabled,
  mergeFeatureFlags,
  readFeatureFlags,
  setFeatureFlag,
  subscribeFeatureFlags,
} from "./featureFlags";

describe("featureFlags", () => {
  it("shipped flags default on but still reversible (I-08: flag off ≈ old path)", () => {
    expect(DEFAULT_FEATURE_FLAGS.effectivePanel).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.sandboxUi).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.worktreeUi).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.agentStripV2).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.reviewMode).toBe(true);
    // Turning sandboxUi off must re-read as false when stored.
    const bag = new Map<string, string>();
    const read = (key: string) => bag.get(key) ?? null;
    const write = (key: string, value: string) => bag.set(key, value);
    setFeatureFlag("sandboxUi", false, read, write);
    expect(isFeatureEnabled("sandboxUi", read)).toBe(false);
  });

  it("mergeFeatureFlags ignores garbage keys and non-booleans", () => {
    expect(mergeFeatureFlags(null)).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(mergeFeatureFlags("x")).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(
      mergeFeatureFlags({ sandboxUi: true, notAFlag: true, worktreeUi: "yes" }),
    ).toEqual({
      ...DEFAULT_FEATURE_FLAGS,
      sandboxUi: true,
    });
  });

  it("readFeatureFlags falls back on missing/corrupt storage", () => {
    expect(readFeatureFlags(() => null)).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(readFeatureFlags(() => "{not-json")).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(readFeatureFlags(() => JSON.stringify({ sandboxUi: true }))).toEqual({
      ...DEFAULT_FEATURE_FLAGS,
      sandboxUi: true,
    });
  });

  it("setFeatureFlag persists and isFeatureEnabled reflects it", () => {
    const bag = new Map<string, string>();
    const read = (key: string) => bag.get(key) ?? null;
    const write = (key: string, value: string) => {
      bag.set(key, value);
    };
    const next = setFeatureFlag("sandboxUi", false, read, write);
    expect(next.sandboxUi).toBe(false);
    expect(bag.get(FEATURE_FLAGS_STORAGE_KEY)).toContain("sandboxUi");
    expect(isFeatureEnabled("sandboxUi", read)).toBe(false);
    // Unset keys keep product defaults (worktreeUi defaults on after A2).
    expect(isFeatureEnabled("worktreeUi", read)).toBe(true);
    setFeatureFlag("worktreeUi", false, read, write);
    expect(isFeatureEnabled("worktreeUi", read)).toBe(false);
  });

  it("notifies same-tab subscribers on setFeatureFlag", () => {
    let hits = 0;
    const unsub = subscribeFeatureFlags(() => {
      hits += 1;
    });
    const bag = new Map<string, string>();
    setFeatureFlag(
      "effectivePanel",
      false,
      (key) => bag.get(key) ?? null,
      (key, value) => bag.set(key, value),
    );
    expect(hits).toBeGreaterThanOrEqual(1);
    unsub();
  });
});

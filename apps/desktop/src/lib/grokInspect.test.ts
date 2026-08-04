import { describe, expect, it, vi } from "vitest";
import {
  fetchGrokInspect,
  parseGrokInspectJson,
  unavailableInspectSnapshot,
} from "./grokInspect";

const sample = {
  grokVersion: "0.2.118",
  channel: "stable",
  cwd: "C:/proj",
  projectRoot: "C:/proj/",
  projectTrusted: true,
  permissions: {
    sources: [],
    loaded: 0,
    managedSettingsExists: false,
    managedSettingsActive: false,
  },
  skills: [{ name: "x" }],
};

describe("parseGrokInspectJson", () => {
  it("parses object and JSON string", () => {
    const fromObj = parseGrokInspectJson(sample);
    expect(fromObj.status).toBe("ok");
    expect(fromObj.grokVersion).toBe("0.2.118");
    expect(fromObj.projectTrusted).toBe(true);
    expect(fromObj.permissions?.loaded).toBe(0);
    expect(fromObj.topLevelKeys).toContain("grokVersion");

    const fromStr = parseGrokInspectJson(JSON.stringify(sample));
    expect(fromStr.status).toBe("ok");
    expect(fromStr.channel).toBe("stable");
  });

  it("degrades on invalid input without throwing", () => {
    expect(parseGrokInspectJson("").status).toBe("error");
    expect(parseGrokInspectJson("{").status).toBe("error");
    expect(parseGrokInspectJson(null).status).toBe("error");
    expect(parseGrokInspectJson([1]).status).toBe("error");
  });
});

describe("fetchGrokInspect", () => {
  it("returns ok snapshot from invoker", async () => {
    const snap = await fetchGrokInspect({
      cwd: "C:/proj",
      invoke: async () => sample,
      now: () => 1000,
    });
    expect(snap.status).toBe("ok");
    expect(snap.grokVersion).toBe("0.2.118");
    expect(snap.durationMs).toBe(0);
  });

  it("degrades on empty cwd", async () => {
    const snap = await fetchGrokInspect({
      cwd: "  ",
      invoke: async () => sample,
    });
    expect(snap.status).toBe("unavailable");
    expect(snap.error).toBe("empty_cwd");
  });

  it("degrades on invoker error without throwing", async () => {
    const snap = await fetchGrokInspect({
      cwd: "C:/proj",
      invoke: async () => {
        throw new Error("cli_missing");
      },
    });
    expect(snap.status).toBe("error");
    expect(snap.error).toBe("cli_missing");
  });

  it("times out and returns timeout status", async () => {
    vi.useFakeTimers();
    const pending = fetchGrokInspect({
      cwd: "C:/proj",
      timeoutMs: 50,
      invoke: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(60);
    const snap = await pending;
    expect(snap.status).toBe("timeout");
    vi.useRealTimers();
  });
});

describe("unavailableInspectSnapshot", () => {
  it("marks browser/mock path", () => {
    expect(unavailableInspectSnapshot().status).toBe("unavailable");
  });
});

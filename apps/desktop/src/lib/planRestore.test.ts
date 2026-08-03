import { describe, it, expect } from "vitest";
import { appendPlanEntry, decideRestoreState } from "./planRestore";

describe("decideRestoreState", () => {
  it("returns default when empty", () => {
    expect(decideRestoreState(undefined)).toEqual({ planActive: false, cliMode: "default" });
    expect(decideRestoreState([])).toEqual({ planActive: false, cliMode: "default" });
  });
  it("keeps plan mode when last verdict is rejected", () => {
    const entries = appendPlanEntry(undefined, { text: "p1", verdict: "rejected" });
    expect(decideRestoreState(entries)).toEqual({ planActive: true, cliMode: "plan" });
  });
  it("clears plan mode after approved or abandoned", () => {
    expect(
      decideRestoreState([{ text: "p", verdict: "approved" }]),
    ).toEqual({ planActive: false, cliMode: "default" });
    expect(
      decideRestoreState([{ text: "p", verdict: "abandoned" }]),
    ).toEqual({ planActive: false, cliMode: "default" });
  });
});

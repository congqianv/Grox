import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPlanHistory,
  recordPlanVerdict,
  restoreDecisionForSession,
  savePlanHistory,
  verdictFromPermissionOption,
} from "./planHistory";

describe("planHistory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("records and loads verdicts", () => {
    recordPlanVerdict("s1", { text: "plan A", verdict: "rejected" });
    expect(loadPlanHistory("s1")).toEqual([{ text: "plan A", verdict: "rejected" }]);
    expect(restoreDecisionForSession("s1")).toEqual({
      planActive: true,
      cliMode: "plan",
    });
  });

  it("approved clears plan-active restore", () => {
    recordPlanVerdict("s1", { text: "p", verdict: "rejected" });
    recordPlanVerdict("s1", { text: "p2", verdict: "approved" });
    expect(restoreDecisionForSession("s1")).toEqual({
      planActive: false,
      cliMode: "default",
    });
  });

  it("maps permission options to verdicts", () => {
    expect(verdictFromPermissionOption("allow_once")).toBe("approved");
    expect(verdictFromPermissionOption("deny")).toBe("abandoned");
    expect(verdictFromPermissionOption("deny", "change X")).toBe("rejected");
  });

  it("savePlanHistory empty clears session", () => {
    recordPlanVerdict("s1", { text: "p", verdict: "rejected" });
    savePlanHistory("s1", []);
    expect(loadPlanHistory("s1")).toEqual([]);
  });
});

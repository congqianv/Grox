import { describe, expect, it } from "vitest";
import { concurrentHintText, concurrentSoftHint } from "./concurrentSessions";

describe("concurrentSoftHint", () => {
  it("never blocks — only soft/info levels", () => {
    const many = concurrentSoftHint({
      sessions: [
        { id: "1", title: "a", status: "running" },
        { id: "2", title: "b", status: "running" },
        { id: "3", title: "c", status: "running" },
        { id: "4", title: "d", status: "idle" },
      ],
      activeId: "1",
      activeSubagentCount: 5,
    });
    expect(many.show).toBe(true);
    expect(many.level).toBe("soft");
    expect(many.otherRunningIds).toEqual(["2", "3"]);
    expect(concurrentHintText(many, false)).toMatch(/soft hint|Heavy/i);
  });

  it("quiet when single idle", () => {
    const quiet = concurrentSoftHint({
      sessions: [{ id: "1", title: "a", status: "idle" }],
      activeId: "1",
      activeSubagentCount: 0,
    });
    expect(quiet.show).toBe(false);
    expect(quiet.level).toBe("none");
  });
});

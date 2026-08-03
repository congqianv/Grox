import { describe, it, expect } from "vitest";
import { applySlashPick, filterCommands, getSlashQuery } from "./slashFilter";

const cmds = [
  { name: "plan", description: "Plan mode" },
  { name: "compact", description: "Compact" },
  { name: "agent", description: "Agent mode" },
];

describe("getSlashQuery", () => {
  it("reads query at caret after line-start slash", () => {
    expect(getSlashQuery("/pl", 3)).toBe("pl");
    expect(getSlashQuery("hello\n/co", 9)).toBe("co");
    expect(getSlashQuery("no slash", 3)).toBeNull();
  });
});

describe("filterCommands", () => {
  it("prefix-filters", () => {
    expect(filterCommands(cmds, "p").map((c) => c.name)).toEqual(["plan"]);
    expect(filterCommands(cmds, "").length).toBe(3);
  });
});

describe("applySlashPick", () => {
  it("replaces partial slash with command + space", () => {
    const r = applySlashPick("/pl", 3, "plan");
    expect(r.text).toBe("/plan ");
    expect(r.caret).toBe("/plan ".length);
  });
});

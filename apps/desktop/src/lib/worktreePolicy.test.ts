import { describe, expect, it } from "vitest";
import {
  bindWorktreePath,
  DEFAULT_WORKSPACE_BIND_MODE,
  parseWorktreeList,
  worktreeListDegradeMessage,
} from "./worktreePolicy";

describe("parseWorktreeList", () => {
  it("parses array and wrapped shapes", () => {
    expect(
      parseWorktreeList([
        { id: "a", path: "C:/wt/a", branch: "feat/a" },
        { name: "b", cwd: "C:/wt/b" },
      ]),
    ).toEqual([
      { id: "a", path: "C:/wt/a", name: undefined, branch: "feat/a", repo: undefined },
      { id: "b", path: "C:/wt/b", name: "b", branch: undefined, repo: undefined },
    ]);
    expect(
      parseWorktreeList({ worktrees: [{ path: "/tmp/x", id: "x" }] }),
    ).toHaveLength(1);
  });

  it("skips invalid rows", () => {
    expect(parseWorktreeList(null)).toEqual([]);
    expect(parseWorktreeList([{ foo: 1 }, "x"])).toEqual([]);
  });
});

describe("bindWorktreePath I-06", () => {
  it("defaults bind mode to local", () => {
    expect(DEFAULT_WORKSPACE_BIND_MODE).toBe("local");
  });

  it("rejects missing/invalid paths so no session is created with bad cwd", () => {
    expect(
      bindWorktreePath({ id: "1", path: "C:/nope" }, {
        pathExists: () => false,
        pathIsDirectory: () => false,
      }).ok,
    ).toBe(false);

    expect(
      bindWorktreePath({ id: "1", path: "C:/file.txt" }, {
        pathExists: () => true,
        pathIsDirectory: () => false,
      }),
    ).toEqual({ ok: false, reason: "not_directory" });

    expect(
      bindWorktreePath({ id: "1", path: "C:/good" }, {
        pathExists: () => true,
        pathIsDirectory: () => true,
      }),
    ).toEqual({
      ok: true,
      path: "C:/good",
      entry: { id: "1", path: "C:/good" },
    });
  });
});

describe("worktreeListDegradeMessage", () => {
  it("never claims parallel is disabled without git", () => {
    expect(worktreeListDegradeMessage("unavailable", false)).toMatch(/multi-session/i);
    expect(worktreeListDegradeMessage("error", true)).toMatch(/Local/);
  });
});

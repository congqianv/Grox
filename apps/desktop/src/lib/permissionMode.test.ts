import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  readStoredPermissionMode,
} from "../bridge/types";

describe("readStoredPermissionMode", () => {
  it("defaults to auto when unset", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
    expect(readStoredPermissionMode(() => null)).toBe("auto");
    expect(readStoredPermissionMode(() => "")).toBe("auto");
    expect(readStoredPermissionMode(() => "garbage")).toBe("auto");
  });

  it("honors explicit stored values", () => {
    expect(readStoredPermissionMode(() => "auto")).toBe("auto");
    expect(readStoredPermissionMode(() => "default")).toBe("default");
    expect(readStoredPermissionMode(() => "bypass")).toBe("bypass");
  });
});

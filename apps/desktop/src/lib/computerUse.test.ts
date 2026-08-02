import { afterEach, describe, expect, it } from "vitest";
import {
  COMPUTER_USE_STORAGE_KEY,
  computerLeaseIfAttached,
  hasActiveComputerLease,
  isComputerUseOperatorEnabled,
  setComputerUseOperatorEnabled,
} from "./computerUse";

describe("computerUse opt-in", () => {
  afterEach(() => {
    localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
  });

  it("defaults to disabled", () => {
    localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("enables and disables via setter", () => {
    setComputerUseOperatorEnabled(true);
    expect(localStorage.getItem(COMPUTER_USE_STORAGE_KEY)).toBe("1");
    expect(isComputerUseOperatorEnabled()).toBe(true);
    setComputerUseOperatorEnabled(false);
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("refuses computer attach when opt-in is off (shipped helper)", () => {
    setComputerUseOperatorEnabled(false);
    // attach path gates on this helper — must be false by default.
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });
});

describe("computerLeaseIfAttached (soft-fail CU)", () => {
  it("returns null for soft-fail empty MCP (must not populate computerLeases)", () => {
    // Mirrors Rust computer_session_extensions when gate closed.
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: [],
        leaseId: "",
      }),
    ).toBeNull();
  });

  it("returns null when computer is null/undefined", () => {
    expect(computerLeaseIfAttached(null)).toBeNull();
    expect(computerLeaseIfAttached(undefined)).toBeNull();
  });

  it("returns null when lists non-empty but leaseId empty (incomplete attach)", () => {
    expect(
      computerLeaseIfAttached({
        mcpServers: [{ type: "http" }],
        pluginDirs: [],
        leaseId: "",
      }),
    ).toBeNull();
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: ["/plugins/cu"],
        leaseId: "   ",
      }),
    ).toBeNull();
  });

  it("returns leaseId only when MCP/plugin attached with real lease", () => {
    expect(
      computerLeaseIfAttached({
        mcpServers: [{ type: "http", name: "grok_desktop_computer" }],
        pluginDirs: [],
        leaseId: "abc123",
      }),
    ).toBe("abc123");
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: ["C:\\plugin"],
        leaseId: "def456",
      }),
    ).toBe("def456");
  });

  it("hasActiveComputerLease ignores empty-string map entries", () => {
    const leases = new Map<string, string>([
      ["sess-empty", ""],
      ["sess-real", "lease-ok"],
    ]);
    expect(hasActiveComputerLease(leases, "sess-empty")).toBe(false);
    expect(hasActiveComputerLease(leases, "sess-missing")).toBe(false);
    expect(hasActiveComputerLease(leases, "sess-real")).toBe(true);
  });
});

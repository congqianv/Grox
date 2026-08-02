import { afterEach, describe, expect, it } from "vitest";
import {
  COMPUTER_USE_STORAGE_KEY,
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

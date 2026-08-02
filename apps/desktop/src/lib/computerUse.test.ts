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
});

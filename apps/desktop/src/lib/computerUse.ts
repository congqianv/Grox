/** localStorage key for operator opt-in to Computer Use (desktop control). */
export const COMPUTER_USE_STORAGE_KEY = "grox.computerUseEnabled";

/**
 * Computer Use requires explicit operator enablement (Settings toggle) or
 * process env GROX_COMPUTER_USE=1 (advanced). Default is off.
 */
export function isComputerUseOperatorEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem(COMPUTER_USE_STORAGE_KEY) === "1") return true;
    }
  } catch {
    /* private mode */
  }
  return false;
}

export function setComputerUseOperatorEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(COMPUTER_USE_STORAGE_KEY, "1");
    else localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

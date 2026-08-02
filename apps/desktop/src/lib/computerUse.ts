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

/** Shape returned by tauri `computer_session_extensions` (camelCase). */
export type ComputerSessionExtensionsShape = {
  mcpServers: unknown[];
  pluginDirs: string[];
  leaseId: string;
};

/**
 * Only store a lease when MCP/plugin was actually attached.
 * Soft-fail (opt-in off) returns empty lists + empty leaseId — must NOT
 * populate computerLeases, or ensureComputerAttachedForPrompt short-circuits
 * and skips the operator-facing opt-in error / later CU-on attach.
 */
export function computerLeaseIfAttached(
  computer: ComputerSessionExtensionsShape | null | undefined,
): string | null {
  if (!computer) return null;
  const hasMcp = computer.mcpServers.length > 0 || computer.pluginDirs.length > 0;
  if (!hasMcp) return null;
  const lease = computer.leaseId?.trim() ?? "";
  if (!lease) return null;
  return lease;
}

/** True when the session map already holds a real (non-empty) CU lease. */
export function hasActiveComputerLease(
  leases: ReadonlyMap<string, string>,
  sessionId: string,
): boolean {
  const lease = leases.get(sessionId);
  return typeof lease === "string" && lease.length > 0;
}

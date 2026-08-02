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

/**
 * Prompt-time Computer Use attach policy (R4A-CU-01).
 * Opt-in is re-checked even when a lease is already mapped so Settings OFF
 * revokes stale control instead of short-circuiting as "already attached".
 */
export type ComputerAttachDecision =
  | "skip"
  | "already_attached"
  | "refuse_opt_in"
  | "revoke_stale_and_refuse"
  | "attach";

export function decideComputerAttachForPrompt(input: {
  requestsComputer: boolean;
  knownSession: boolean;
  optIn: boolean;
  hasActiveLease: boolean;
}): ComputerAttachDecision {
  if (!input.requestsComputer || !input.knownSession) return "skip";
  if (!input.optIn) {
    return input.hasActiveLease ? "revoke_stale_and_refuse" : "refuse_opt_in";
  }
  if (input.hasActiveLease) return "already_attached";
  return "attach";
}

/** Operator-facing copy when Computer Use is refused (Settings General). */
export const COMPUTER_USE_OPT_IN_REFUSE_MESSAGE =
  "Computer Use 未启用。请在 设置 中打开「允许 Computer Use」后再试。";

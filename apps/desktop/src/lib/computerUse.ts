/** localStorage key for operator opt-in to Computer Use (desktop control). */
export const COMPUTER_USE_STORAGE_KEY = "grox.computerUseEnabled";

/** Process env name (desktop host + advanced operators). Mirrors Rust gate. */
export const COMPUTER_USE_ENV_KEY = "GROX_COMPUTER_USE";

/**
 * Parse GROX_COMPUTER_USE-style values (`1` / `true`, case-insensitive).
 * Pure — used by unit tests and host cache application.
 */
export function isComputerUseEnvFlag(value: string | null | undefined): boolean {
  if (value == null) return false;
  const v = value.trim();
  return v === "1" || v.toLowerCase() === "true";
}

/** Host-process env cache (Tauri invoke); null = not yet refreshed. */
let hostEnvEnabled: boolean | null = null;

/** Apply host env probe result (from `computer_use_env_enabled` command). */
export function setComputerUseHostEnvEnabled(enabled: boolean): void {
  hostEnvEnabled = enabled;
}

/** Test/reset helper — clears host env cache. */
export function resetComputerUseHostEnvCache(): void {
  hostEnvEnabled = null;
}

function readProcessEnvComputerUse(): string | undefined {
  try {
    // Avoid Node types dependency in the desktop Vite tsconfig; probe globalThis.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    return proc?.env?.[COMPUTER_USE_ENV_KEY];
  } catch {
    /* browser */
  }
  return undefined;
}

/**
 * Computer Use requires Settings toggle **or** host env GROX_COMPUTER_USE=1
 * (advanced). Default is off. Host env is authoritative once refreshed via
 * Tauri; process.env is used in Node/vitest and as a bootstrap fallback.
 */
export function isComputerUseOperatorEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem(COMPUTER_USE_STORAGE_KEY) === "1") return true;
    }
  } catch {
    /* private mode */
  }
  if (hostEnvEnabled === true) return true;
  if (isComputerUseEnvFlag(readProcessEnvComputerUse())) return true;
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

/**
 * grok inspect — parse + async fetch with timeout degrade (A0).
 *
 * Shell never blocks chat on inspect failure. Callers treat status !== "ok"
 * as degraded dual-state (applied = unknown).
 */

export type GrokInspectStatus = "ok" | "error" | "unavailable" | "loading" | "timeout";

export interface GrokInspectPermissions {
  loaded: number;
  managedSettingsExists: boolean;
  managedSettingsActive: boolean;
}

export interface GrokInspectSnapshot {
  status: GrokInspectStatus;
  grokVersion?: string;
  channel?: string;
  cwd?: string;
  projectRoot?: string;
  projectTrusted?: boolean;
  permissions?: GrokInspectPermissions;
  /** Truncated raw keys for debug UI (never full skills dump). */
  topLevelKeys?: string[];
  error?: string;
  fetchedAt: number;
  durationMs?: number;
}

export interface ParseInspectOptions {
  /** Max top-level keys to retain for the panel. */
  maxKeys?: number;
}

/**
 * Normalize CLI `grok inspect --json` stdout into a safe UI snapshot.
 * Accepts already-parsed objects or JSON strings. Never throws.
 */
export function parseGrokInspectJson(
  raw: unknown,
  opts: ParseInspectOptions = {},
): GrokInspectSnapshot {
  const fetchedAt = Date.now();
  const maxKeys = opts.maxKeys ?? 24;

  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { status: "error", error: "empty_inspect_output", fetchedAt };
    }
    try {
      value = JSON.parse(trimmed);
    } catch (cause) {
      return {
        status: "error",
        error: cause instanceof Error ? cause.message : "invalid_json",
        fetchedAt,
      };
    }
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", error: "inspect_not_object", fetchedAt };
  }

  const obj = value as Record<string, unknown>;
  const topLevelKeys = Object.keys(obj).slice(0, maxKeys);

  const permissionsRaw = obj.permissions;
  let permissions: GrokInspectPermissions | undefined;
  if (permissionsRaw !== null && typeof permissionsRaw === "object" && !Array.isArray(permissionsRaw)) {
    const p = permissionsRaw as Record<string, unknown>;
    permissions = {
      loaded: typeof p.loaded === "number" ? p.loaded : 0,
      managedSettingsExists: p.managedSettingsExists === true,
      managedSettingsActive: p.managedSettingsActive === true,
    };
  }

  return {
    status: "ok",
    grokVersion: typeof obj.grokVersion === "string" ? obj.grokVersion : undefined,
    channel: typeof obj.channel === "string" ? obj.channel : undefined,
    cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
    projectRoot: typeof obj.projectRoot === "string" ? obj.projectRoot : undefined,
    projectTrusted: typeof obj.projectTrusted === "boolean" ? obj.projectTrusted : undefined,
    permissions,
    topLevelKeys,
    fetchedAt,
  };
}

export type InspectInvoker = (cwd: string) => Promise<unknown>;

export interface FetchGrokInspectOptions {
  cwd: string;
  /** Default 12s — inspect must not stall the UI. */
  timeoutMs?: number;
  /** Injected runner (Tauri invoke or test double). */
  invoke: InspectInvoker;
  /** Clock for tests. */
  now?: () => number;
}

/**
 * Call inspect with a hard timeout. On any failure returns degraded snapshot
 * (status error|timeout|unavailable) — never throws.
 */
export async function fetchGrokInspect(
  options: FetchGrokInspectOptions,
): Promise<GrokInspectSnapshot> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const now = options.now ?? Date.now;
  const started = now();
  const cwd = options.cwd.trim();
  if (!cwd) {
    return {
      status: "unavailable",
      error: "empty_cwd",
      fetchedAt: started,
      durationMs: 0,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      options.invoke(cwd),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("inspect_timeout")), timeoutMs);
      }),
    ]);
    const snapshot = parseGrokInspectJson(result);
    return {
      ...snapshot,
      fetchedAt: now(),
      durationMs: Math.max(0, now() - started),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isTimeout = message === "inspect_timeout" || /timeout/i.test(message);
    return {
      status: isTimeout ? "timeout" : "error",
      error: message,
      fetchedAt: now(),
      durationMs: Math.max(0, now() - started),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Build a mock/unavailable snapshot for browser `pnpm dev` without Tauri. */
export function unavailableInspectSnapshot(reason = "not_tauri"): GrokInspectSnapshot {
  return {
    status: "unavailable",
    error: reason,
    fetchedAt: Date.now(),
  };
}

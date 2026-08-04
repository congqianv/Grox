/**
 * Sandbox preference → spawn injection (A0 pure skeleton; wired in A1).
 *
 * Open default: **follow CLI** — do not set GROK_SANDBOX or --sandbox unless
 * the user explicitly chose a profile (product hard rule).
 */

/** User-facing preference. `follow_cli` means shell must not override. */
export type SandboxPreference = "follow_cli" | "workspace" | "read_only" | "off";

/** CLI / env profile tokens when user opts in. */
export type SandboxCliProfile = "workspace" | "read-only" | "off";

export const DEFAULT_SANDBOX_PREFERENCE: SandboxPreference = "follow_cli";

export const SANDBOX_STORAGE_KEY = "grox.sandboxPreference";

export interface SandboxSpawnPlan {
  /** Env vars to inject at agent spawn. Empty when following CLI. */
  env: Record<string, string>;
  /** Extra CLI args (e.g. `--sandbox workspace`). Empty when following CLI. */
  args: string[];
  /** True only when the user explicitly overrode the CLI default. */
  explicit: boolean;
  /** Resolved CLI profile, or null when follow_cli. */
  profile: SandboxCliProfile | null;
}

const PREFERENCE_TO_CLI: Record<Exclude<SandboxPreference, "follow_cli">, SandboxCliProfile> = {
  workspace: "workspace",
  read_only: "read-only",
  off: "off",
};

/**
 * Map UI preference to spawn env/args.
 * I-08 / open default: follow_cli → no injection (matches pre-A1 spawn).
 */
export function resolveSandboxSpawn(preference: SandboxPreference): SandboxSpawnPlan {
  if (preference === "follow_cli") {
    return { env: {}, args: [], explicit: false, profile: null };
  }
  const profile = PREFERENCE_TO_CLI[preference];
  return {
    env: { GROK_SANDBOX: profile },
    args: ["--sandbox", profile],
    explicit: true,
    profile,
  };
}

export function isSandboxPreference(value: unknown): value is SandboxPreference {
  return value === "follow_cli" || value === "workspace" || value === "read_only" || value === "off";
}

/** Read stored preference; unset/garbage → follow_cli (never force sandbox). */
export function readStoredSandboxPreference(
  read: (key: string) => string | null = (key) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
): SandboxPreference {
  const raw = read(SANDBOX_STORAGE_KEY);
  if (isSandboxPreference(raw)) return raw;
  return DEFAULT_SANDBOX_PREFERENCE;
}

export function writeStoredSandboxPreference(
  preference: SandboxPreference,
  write: (key: string, value: string) => void = (key, value) => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
): void {
  write(SANDBOX_STORAGE_KEY, preference);
}

/**
 * I-03: never half-apply sandbox mid-turn.
 *
 * Open default: **do not auto-restart** the agent on preference change.
 * Preference is always stored; it applies on the next ACP spawn / manual reconnect.
 * Auto-restart caused confusing reconnect storms and looked like "sandbox breaks API"
 * when the child failed to start (e.g. bad `--sandbox` argv order on old builds).
 */
export function shouldRestartAgentForSandbox(
  _anySessionBusy: boolean,
  featureEnabled: boolean,
  previous: SandboxPreference,
  next: SandboxPreference,
): "restart_now" | "defer_busy" | "noop" {
  if (!featureEnabled) return "noop";
  if (previous === next) return "noop";
  // Always defer: UI offers "Reconnect to apply" when pending.
  return "defer_busy";
}

/** Spawn profile string for Tauri, or null when shell must not override CLI. */
export function sandboxSpawnArg(
  featureEnabled: boolean,
  preference: SandboxPreference = readStoredSandboxPreference(),
): string | null {
  if (!featureEnabled) return null;
  const plan = resolveSandboxSpawn(preference);
  return plan.explicit ? plan.profile : null;
}

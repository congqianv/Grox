/**
 * Desktop feature flags (A0–D).
 *
 * Flag off ≈ pre-slice behavior (I-08). Preference defaults stay open
 * (sandbox follow_cli, worktree Local) so enabling UI does not tighten spawn.
 */

export type FeatureFlagKey =
  | "effectivePanel"
  | "sandboxUi"
  | "worktreeUi"
  | "agentStripV2"
  | "reviewMode";

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  "effectivePanel",
  "sandboxUi",
  "worktreeUi",
  "agentStripV2",
  "reviewMode",
] as const;

export const FEATURE_FLAGS_STORAGE_KEY = "grox.featureFlags";

/**
 * Product defaults after A0–D land.
 * Off-by-default would hide shipped UI; each flag still restores pre-slice
 * behavior when turned off (I-08). Preferences themselves stay open
 * (sandbox follow_cli, worktree Local) so defaults do not tighten spawn.
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  effectivePanel: true,
  sandboxUi: true,
  worktreeUi: true,
  agentStripV2: true,
  reviewMode: true,
};

export type StorageReader = (key: string) => string | null;
export type StorageWriter = (key: string, value: string) => void;

/** Same-tab listeners (storage events only fire cross-tab). */
const flagListeners = new Set<() => void>();

export function subscribeFeatureFlags(listener: () => void): () => void {
  flagListeners.add(listener);
  return () => {
    flagListeners.delete(listener);
  };
}

export function notifyFeatureFlagsChanged(): void {
  for (const listener of flagListeners) {
    try {
      listener();
    } catch {
      /* ignore listener errors */
    }
  }
  try {
    window.dispatchEvent(new StorageEvent("storage", { key: FEATURE_FLAGS_STORAGE_KEY }));
  } catch {
    /* non-DOM / tests */
  }
}

function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}

/**
 * Merge a partial object into base flags. Unknown keys ignored; non-booleans skipped.
 * Pure — safe for unit tests without localStorage.
 */
export function mergeFeatureFlags(
  partial: unknown,
  base: FeatureFlags = DEFAULT_FEATURE_FLAGS,
): FeatureFlags {
  const next: FeatureFlags = { ...base };
  if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
    return next;
  }
  for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
    if (!isFeatureFlagKey(key)) continue;
    if (typeof value !== "boolean") continue;
    next[key] = value;
  }
  return next;
}

/** Read flags from storage; corrupt/missing → defaults. */
export function readFeatureFlags(
  read: StorageReader = (key) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
): FeatureFlags {
  const raw = read(FEATURE_FLAGS_STORAGE_KEY);
  if (raw == null || raw.trim() === "") return { ...DEFAULT_FEATURE_FLAGS };
  try {
    return mergeFeatureFlags(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}

export function isFeatureEnabled(
  key: FeatureFlagKey,
  read: StorageReader = (keyName) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(keyName) : null;
    } catch {
      return null;
    }
  },
): boolean {
  return readFeatureFlags(read)[key];
}

/** Persist a single flag; returns the full merged snapshot. */
export function setFeatureFlag(
  key: FeatureFlagKey,
  value: boolean,
  read: StorageReader = (keyName) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(keyName) : null;
    } catch {
      return null;
    }
  },
  write: StorageWriter = (keyName, text) => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(keyName, text);
    } catch {
      /* private mode */
    }
  },
): FeatureFlags {
  const next = { ...readFeatureFlags(read), [key]: value };
  write(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(next));
  notifyFeatureFlagsChanged();
  return next;
}

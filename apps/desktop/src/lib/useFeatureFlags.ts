import { useEffect, useState } from "react";
import {
  type FeatureFlags,
  isFeatureEnabled,
  type FeatureFlagKey,
  readFeatureFlags,
  subscribeFeatureFlags,
} from "./featureFlags";

/** Reactive feature flags (same-tab + storage). */
export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState(() => readFeatureFlags());
  useEffect(() => subscribeFeatureFlags(() => setFlags(readFeatureFlags())), []);
  return flags;
}

export function useFeatureEnabled(key: FeatureFlagKey): boolean {
  const flags = useFeatureFlags();
  return flags[key];
}

/** One-shot helper that still re-renders when flags change. */
export function useIsFeatureEnabled(key: FeatureFlagKey): boolean {
  const [on, setOn] = useState(() => isFeatureEnabled(key));
  useEffect(
    () =>
      subscribeFeatureFlags(() => {
        setOn(isFeatureEnabled(key));
      }),
    [key],
  );
  return on;
}

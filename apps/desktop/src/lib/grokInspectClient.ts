/**
 * Desktop entry for `grok inspect` (A0).
 * Uses Tauri when available; degrades cleanly in browser mock mode.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  fetchGrokInspect,
  type GrokInspectSnapshot,
  unavailableInspectSnapshot,
} from "./grokInspect";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Fetch inspect for workspace cwd. Never throws — always a snapshot with status.
 */
export async function loadGrokInspect(
  cwd: string,
  timeoutMs = 12_000,
): Promise<GrokInspectSnapshot> {
  if (!inTauri()) {
    return unavailableInspectSnapshot("not_tauri");
  }
  return fetchGrokInspect({
    cwd,
    timeoutMs,
    invoke: async (workspace) => {
      // Native command returns parsed JSON object (serde_json::Value).
      return invoke<unknown>("grok_inspect", { cwd: workspace });
    },
  });
}

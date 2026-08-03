/* Plan verdict history persistence for Grox desktop.
 * Uses planRestore pure helpers (vscode-supergrok MIT lineage).
 */

import {
  appendPlanEntry,
  decideRestoreState,
  type PlanEntry,
  type PlanVerdict,
  type RestoreDecision,
} from "./planRestore";

const STORAGE_KEY = "grox.planHistory.v1";
const MAX_SESSIONS = 80;
const MAX_ENTRIES_PER_SESSION = 40;

type Store = Record<string, PlanEntry[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const ids = Object.keys(store);
    if (ids.length > MAX_SESSIONS) {
      // Drop oldest keys (insertion order is not guaranteed; trim by entry count then id).
      const ranked = ids
        .map((id) => ({ id, n: store[id]?.length ?? 0 }))
        .sort((a, b) => a.n - b.n);
      for (const { id } of ranked.slice(0, ids.length - MAX_SESSIONS)) {
        delete store[id];
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota / private mode */
  }
}

export function loadPlanHistory(sessionId: string): PlanEntry[] {
  if (!sessionId) return [];
  return [...(readStore()[sessionId] ?? [])];
}

export function savePlanHistory(sessionId: string, entries: PlanEntry[]): void {
  if (!sessionId) return;
  const store = readStore();
  const trimmed = entries.slice(-MAX_ENTRIES_PER_SESSION);
  if (trimmed.length === 0) delete store[sessionId];
  else store[sessionId] = trimmed;
  writeStore(store);
}

export function recordPlanVerdict(
  sessionId: string,
  entry: PlanEntry,
): PlanEntry[] {
  const next = appendPlanEntry(loadPlanHistory(sessionId), entry);
  savePlanHistory(sessionId, next);
  return next;
}

export function restoreDecisionForSession(sessionId: string): RestoreDecision {
  return decideRestoreState(loadPlanHistory(sessionId));
}

export function verdictFromPermissionOption(
  option: "allow_once" | "allow_always" | "deny",
  feedback?: string,
): PlanVerdict {
  if (option === "deny") {
    return feedback?.trim() ? "rejected" : "abandoned";
  }
  return "approved";
}

export type { PlanEntry, PlanVerdict, RestoreDecision };

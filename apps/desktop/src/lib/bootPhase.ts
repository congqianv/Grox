/* Shared-first agent boot: phase labels + sticky local-fallback copy. */

import type { BootPhase } from "../bridge/types";

/** Shared-leader initialize handshake budget (design: 12–15s). */
export const SHARED_INIT_TIMEOUT_MS = 14_000;
/** Local / sticky-fallback initialize budget. */
export const LOCAL_INIT_TIMEOUT_MS = 45_000;
/** `acp_spawn` wall clock (process start, not handshake). */
export const SPAWN_TIMEOUT_MS = 30_000;

export function bootPhaseLabel(phase: BootPhase | null | undefined, zh: boolean): string {
  switch (phase) {
    case "preflight":
      return zh ? "启动预检…" : "Boot preflight…";
    case "spawning_shared":
      return zh ? "启动共享 Leader…" : "Starting shared leader…";
    case "initializing_shared":
      return zh ? "连接共享 Leader…" : "Connecting to shared leader…";
    case "fallback_local":
      return zh ? "共享 Leader 不可用，切换独立进程…" : "Shared leader unavailable — switching to local…";
    case "spawning_local":
      return zh ? "启动独立进程…" : "Starting local agent…";
    case "initializing_local":
      return zh ? "初始化独立进程…" : "Initializing local agent…";
    case "ready":
      return zh ? "已就绪" : "Ready";
    default:
      return zh ? "正在连接 Grok…" : "Connecting to Grok…";
  }
}

export function bootFallbackNoticeText(zh: boolean, reason?: string): string {
  const base = zh
    ? "共享 Leader 连接失败，已自动切换为独立进程（可在设置中改回共享）。"
    : "Shared leader failed; switched to a local agent process (change back in Settings).";
  const detail = reason?.trim();
  if (!detail) return base;
  return `${base} ${zh ? "原因：" : "Reason: "}${detail}`;
}

/* Shared-first agent boot: phase labels + soft local-fallback copy. */

import type { BootPhase } from "../bridge/types";

/**
 * Warm shared-leader handshake budget (leader already up).
 * Keep short so a wedged join fails fast into soft local.
 */
export const SHARED_WARM_INIT_TIMEOUT_MS = 14_000;
/**
 * Cold shared-leader budget (no machine leader / first attach after idle).
 * Leader may need to spawn + open wss://code.grok.com before ACP initialize.
 */
export const SHARED_COLD_INIT_TIMEOUT_MS = 28_000;
/** @deprecated Prefer SHARED_WARM / SHARED_COLD — kept for older tests. */
export const SHARED_INIT_TIMEOUT_MS = SHARED_WARM_INIT_TIMEOUT_MS;
/** Local / soft-fallback initialize budget. */
export const LOCAL_INIT_TIMEOUT_MS = 45_000;
/** `acp_spawn` wall clock (process start, not handshake). */
export const SPAWN_TIMEOUT_MS = 30_000;

/** Pick shared handshake budget from preflight liveness. */
export function sharedInitTimeoutMs(machineLeaderAlive: boolean | undefined): number {
  return machineLeaderAlive ? SHARED_WARM_INIT_TIMEOUT_MS : SHARED_COLD_INIT_TIMEOUT_MS;
}

export function bootPhaseLabel(phase: BootPhase | null | undefined, zh: boolean): string {
  switch (phase) {
    case "preflight":
      return zh ? "启动预检…" : "Boot preflight…";
    case "spawning_shared":
      return zh ? "启动共享 Leader…" : "Starting shared leader…";
    case "initializing_shared":
      return zh ? "连接共享 Leader…" : "Connecting to shared leader…";
    case "fallback_local":
      return zh ? "共享 Leader 繁忙，改用独立进程…" : "Shared leader busy — using local process…";
    case "spawning_local":
      return zh ? "启动独立进程…" : "Starting local process…";
    case "initializing_local":
      return zh ? "初始化独立进程…" : "Initializing local process…";
    case "ready":
      return zh ? "已就绪" : "Ready";
    default:
      return zh ? "正在连接 Grok…" : "Connecting to Grok…";
  }
}

/**
 * Soft-fallback banner (session-only). Avoids the word "Agent" so StatusBar
 * does not treat this as a crash and demand manual reconnect.
 */
export function bootFallbackNoticeText(zh: boolean, reason?: string): string {
  const base = zh
    ? "共享 Leader 暂时繁忙或冷启动较慢，本次已改用独立进程（设置仍为共享；下次启动会再试共享）。"
    : "Shared leader was busy or slow; this session uses a local process (preference stays shared; next launch retries shared).";
  const detail = reason?.trim();
  if (!detail) return base;
  // Keep reason short for the gold banner.
  const short =
    detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  return `${base} ${zh ? "详情：" : "Detail: "}${short}`;
}

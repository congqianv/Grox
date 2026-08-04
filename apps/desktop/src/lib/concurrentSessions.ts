/**
 * Soft concurrency hints (B1) — never hard-block parallel sessions or subagents.
 */

export interface SessionRunSnapshot {
  id: string;
  title: string;
  status: "idle" | "running" | "awaiting_permission" | "awaiting_input" | string;
}

export interface ConcurrentSoftHint {
  /** True when we should show a gentle banner (not a modal block). */
  show: boolean;
  level: "none" | "info" | "soft";
  runningCount: number;
  subagentCount: number;
  /** Other running session ids (exclude active). */
  otherRunningIds: string[];
}

export const DEFAULT_SOFT_SESSION_THRESHOLD = 3;
export const DEFAULT_SOFT_SUBAGENT_THRESHOLD = 4;

export function concurrentSoftHint(input: {
  sessions: SessionRunSnapshot[];
  activeId: string | null | undefined;
  activeSubagentCount: number;
  sessionThreshold?: number;
  subagentThreshold?: number;
}): ConcurrentSoftHint {
  const sessionThreshold = input.sessionThreshold ?? DEFAULT_SOFT_SESSION_THRESHOLD;
  const subagentThreshold = input.subagentThreshold ?? DEFAULT_SOFT_SUBAGENT_THRESHOLD;
  const running = input.sessions.filter(
    (s) => s.status === "running" || s.status === "awaiting_permission",
  );
  const otherRunningIds = running
    .filter((s) => s.id !== input.activeId)
    .map((s) => s.id);
  const runningCount = running.length;
  const subagentCount = Math.max(0, input.activeSubagentCount);

  let level: ConcurrentSoftHint["level"] = "none";
  if (runningCount >= sessionThreshold || subagentCount >= subagentThreshold) {
    level = "soft";
  } else if (runningCount > 1 || subagentCount > 1) {
    level = "info";
  }

  return {
    show: level !== "none",
    level,
    runningCount,
    subagentCount,
    otherRunningIds,
  };
}

export function concurrentHintText(hint: ConcurrentSoftHint, zh: boolean): string {
  if (!hint.show) return "";
  if (zh) {
    if (hint.level === "soft") {
      return `并行较多（会话 ${hint.runningCount} · 子代理 ${hint.subagentCount}）— 仅提示，不拦截`;
    }
    return `并行中：${hint.runningCount} 个忙碌会话` + (hint.subagentCount ? ` · ${hint.subagentCount} 子代理` : "");
  }
  if (hint.level === "soft") {
    return `Heavy parallelism (${hint.runningCount} sessions · ${hint.subagentCount} subagents) — soft hint only`;
  }
  return `Parallel: ${hint.runningCount} busy session(s)` + (hint.subagentCount ? ` · ${hint.subagentCount} subagent(s)` : "");
}

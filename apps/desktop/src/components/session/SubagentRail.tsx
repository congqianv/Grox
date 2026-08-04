/* ─────────────────────────────────────────────────────────────────────────
   SubagentRail — Claude/Codex-style right rail for live + recent subagents.
   Replaces the cramped bottom strip above the composer.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Usage } from "../../bridge/types";
import {
  extractActiveSubagents,
  extractRecentSubagents,
  focusTimelineBlock,
  subagentTone,
  type ActiveSubagent,
} from "../../lib/activeProcesses";
import {
  concurrentHintText,
  concurrentSoftHint,
} from "../../lib/concurrentSessions";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";

type UsageSnap = { in: number; out: number; cache: number; cost: number };

function snapUsage(u: Usage): UsageSnap {
  return {
    in: u.inputTokens || 0,
    out: u.outputTokens || 0,
    cache: u.cacheReadTokens || 0,
    cost: u.costUSD || 0,
  };
}

/** Best-effort attribution: session usage delta while agent was live (shared across concurrent agents). */
function formatDelta(start: UsageSnap | undefined, end: UsageSnap, zh: boolean): string {
  if (!start) return zh ? "token —" : "tok —";
  const dIn = Math.max(0, end.in - start.in);
  const dOut = Math.max(0, end.out - start.out);
  const dTotal = dIn + dOut;
  if (dTotal <= 0) return zh ? "token ~0" : "tok ~0";
  return `↑${fmtTokens(dIn)} ↓${fmtTokens(dOut)}`;
}

const RAIL_W = 280;

function statusLabel(status: ActiveSubagent["status"], zh: boolean): string {
  switch (status) {
    case "awaiting_permission":
      return zh ? "待批准" : "gated";
    case "pending":
      return zh ? "排队" : "queued";
    case "running":
      return zh ? "运行中" : "running";
    case "done":
      return zh ? "完成" : "done";
    case "error":
      return zh ? "错误" : "error";
    case "cancelled":
      return zh ? "取消" : "cancelled";
    default:
      return status;
  }
}

function typeLabel(agentType: string, zh: boolean): string {
  const key = agentType.toLowerCase();
  if (zh) {
    if (key === "explore") return "探索";
    if (key === "plan") return "计划";
    if (key === "general-purpose" || key === "general") return "通用";
    if (key === "code") return "代码";
    if (key === "subagent") return "子代理";
  }
  return agentType;
}

function AgentCard({
  agent,
  index,
  zh,
  dimmed,
  tokenLine,
}: {
  agent: ActiveSubagent;
  index: number;
  zh: boolean;
  dimmed?: boolean;
  tokenLine: string;
}) {
  const tone = subagentTone(agent, index);
  const [now, setNow] = useState(Date.now());
  const live =
    agent.status === "running" ||
    agent.status === "pending" ||
    agent.status === "awaiting_permission";

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const elapsed = Math.max(
    0,
    (agent.endedAtHint ?? now) - agent.startedAt,
  );

  return (
    <button
      type="button"
      onClick={() => focusTimelineBlock(agent.blockId)}
      className={`group w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${tone.border} ${tone.bg} ${
        dimmed ? "opacity-70" : ""
      } hover:brightness-110`}
      title={zh ? "点击定位到时间线" : "Locate in timeline"}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${live ? "animate-pulse-dot" : ""}`}
        />
        <span className={`font-mono text-[9.5px] uppercase tracking-[0.08em] ${tone.text}`}>
          {typeLabel(agent.agentType, zh)}
        </span>
        <span className={`ml-auto font-mono text-[9px] uppercase ${tone.text} opacity-75`}>
          {statusLabel(agent.status, zh)}
        </span>
      </div>
      <p className={`line-clamp-2 font-mono text-[11.5px] leading-snug ${tone.text}`}>
        {agent.title}
      </p>
      {agent.detail && agent.detail !== agent.title && (
        <p className="mt-0.5 line-clamp-1 font-mono text-[10px] text-faint">{agent.detail}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="tnum text-[10px] text-faint">{fmtDuration(elapsed)}</span>
        <span
          className="tnum text-[10px] text-mute"
          title={
            zh
              ? "会话用量增量估算（多子代理并行时共享，非精确分账）"
              : "Approx. session usage delta (shared if concurrent; not exact per-agent)"
          }
        >
          {tokenLine}
        </span>
        <Icon name="chevronRight" size={9} className="ml-auto text-faint opacity-0 group-hover:opacity-100" />
      </div>
    </button>
  );
}

/**
 * Right-side subagent rail. Returns null when flag off or nothing to show
 * (collapsed empty state is a thin optional chip only when history exists).
 */
export function SubagentRail({ session, zh }: { session: Session; zh: boolean }) {
  const enabled = useIsFeatureEnabled("agentStripV2");
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);
  const openSession = useDesktop((s) => s.openSession);
  const [collapsed, setCollapsed] = useState(false);
  const [showHistory, setShowHistory] = useState(true);

  const live = useMemo(() => extractActiveSubagents(session), [session]);
  const recent = useMemo(() => extractRecentSubagents(session, 12), [session]);
  const usage = session.usage;
  const usageNow = useMemo(() => snapUsage(usage), [usage]);

  // Snapshot session usage when each agent first appears / finishes (best-effort).
  const startSnap = useRef(new Map<string, UsageSnap>());
  const endSnap = useRef(new Map<string, UsageSnap>());
  useEffect(() => {
    for (const a of live) {
      if (!startSnap.current.has(a.id)) startSnap.current.set(a.id, usageNow);
    }
    for (const a of recent) {
      if (!startSnap.current.has(a.id)) startSnap.current.set(a.id, usageNow);
      if (!endSnap.current.has(a.id)) endSnap.current.set(a.id, usageNow);
    }
  }, [live, recent, usageNow]);

  const tokenLineFor = (id: string, finished: boolean) => {
    const start = startSnap.current.get(id);
    const end = finished ? endSnap.current.get(id) ?? usageNow : usageNow;
    return formatDelta(start, end, zh);
  };

  const hint = useMemo(() => {
    if (!enabled) return null;
    return concurrentSoftHint({
      sessions: Object.values(sessions).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
      })),
      activeId,
      activeSubagentCount: live.length,
    });
  }, [enabled, sessions, activeId, live.length]);

  const otherRunning = useMemo(() => {
    if (!hint?.otherRunningIds.length) return [];
    return hint.otherRunningIds
      .map((id) => sessions[id])
      .filter(Boolean)
      .slice(0, 5);
  }, [hint, sessions]);

  if (!enabled) return null;
  if (live.length === 0 && recent.length === 0 && !hint?.show) return null;

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-line bg-panel py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-dim hover:bg-high hover:text-fg"
          title={zh ? "展开子代理面板" : "Expand subagents"}
        >
          <Icon name="layers" size={14} />
        </button>
        {live.length > 0 && (
          <span className="mt-1 font-mono text-[9px] text-gold">{live.length}</span>
        )}
      </div>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: RAIL_W }}
      aria-label={zh ? "子代理" : "Subagents"}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Icon name="layers" size={12} className="text-acc" />
        <span
          className="font-mono text-[10px] tracking-[0.12em] text-fg2"
          title={
            zh
              ? "真·子代理进度/历史（不含 shell）。Plan 步骤在右侧「任务」Tab。"
              : "Real subagent progress/history (no shell). Plan steps live under Tasks."
          }
        >
          {zh ? "子代理" : "AGENTS"}
        </span>
        {live.length > 0 && (
          <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-[9px] text-gold">
            {live.length} {zh ? "运行" : "live"}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="ml-auto flex h-6 w-6 items-center justify-center text-faint hover:text-fg"
          title={zh ? "收起" : "Collapse"}
        >
          <Icon name="chevronRight" size={10} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2.5">
        <div className="rounded-md border border-line bg-raise/80 px-2 py-1.5 font-mono text-[10px] text-mute">
          <div className="text-faint">{zh ? "会话用量（合计）" : "Session usage"}</div>
          <div className="mt-0.5 tnum text-fg2">
            ↑{fmtTokens(usageNow.in)} ↓{fmtTokens(usageNow.out)}
            {usageNow.cache > 0 ? ` · cache ${fmtTokens(usageNow.cache)}` : ""}
            {" · "}
            {fmtCost(usageNow.cost)}
          </div>
          <div className="mt-0.5 text-[9px] leading-snug text-faint">
            {zh
              ? "单卡 token 为运行期间会话增量估算；并行时共享，非上游精确分账。"
              : "Per-card tokens ≈ session delta while live; shared if concurrent."}
          </div>
        </div>

        {hint?.show && (
          <div className="rounded-md border border-gold/25 bg-gold/5 px-2 py-1.5 font-mono text-[10px] leading-snug text-gold">
            {concurrentHintText(hint, zh)}
          </div>
        )}

        {otherRunning.length > 0 && (
          <div>
            <p className="mb-1.5 px-0.5 font-mono text-[9px] tracking-wide text-faint">
              {zh ? "其他忙碌会话" : "OTHER SESSIONS"}
            </p>
            <div className="flex flex-col gap-1">
              {otherRunning.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void openSession(s.id)}
                  className="truncate rounded-md border border-line2 bg-raise px-2 py-1.5 text-left font-mono text-[10.5px] text-mute hover:border-line3 hover:text-fg2"
                >
                  {s.title.slice(0, 36) || s.id.slice(0, 8)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 px-0.5 font-mono text-[9px] tracking-wide text-faint">
            {zh ? "进行中" : "IN PROGRESS"}
          </p>
          {live.length === 0 ? (
            <p className="px-0.5 py-2 text-[11px] leading-relaxed text-faint">
              {zh
                ? "当前无运行中的子代理（不含普通 shell/工具）"
                : "No live subagents (plain shell tools are hidden)"}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {live.map((agent, index) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  index={index}
                  zh={zh}
                  tokenLine={tokenLineFor(agent.id, false)}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="mb-1.5 flex w-full items-center justify-between px-0.5"
          >
            <span className="font-mono text-[9px] tracking-wide text-faint">
              {zh ? "历史" : "HISTORY"}
              {recent.length > 0 ? ` · ${recent.length}` : ""}
            </span>
            <Icon
              name="chevronDown"
              size={9}
              className={`text-faint transition-transform ${showHistory ? "rotate-180" : ""}`}
            />
          </button>
          {showHistory &&
            (recent.length === 0 ? (
              <p className="px-0.5 py-2 text-[11px] leading-relaxed text-faint">
                {zh
                  ? "尚无已完成的子代理。普通 Task/shell 不会出现在这里。只有 spawn_subagent 等真子代理会列出。"
                  : "No finished subagents. Plain Task/shell tools are omitted — only real spawns appear."}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {recent.map((agent, index) => (
                  <AgentCard
                    key={`h-${agent.id}`}
                    agent={agent}
                    index={index}
                    zh={zh}
                    dimmed
                    tokenLine={tokenLineFor(agent.id, true)}
                  />
                ))}
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
}

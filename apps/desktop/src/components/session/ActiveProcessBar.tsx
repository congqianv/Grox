/* Live subagent strip + optional history / parallel soft hints (B1). */

import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../bridge/types";
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
import { fmtDuration } from "../../lib/format";
import { useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";

function statusLabel(status: ActiveSubagent["status"], zh: boolean): string {
  switch (status) {
    case "awaiting_permission":
      return zh ? "待批准" : "gated";
    case "pending":
      return zh ? "排队" : "queued";
    case "done":
      return zh ? "完成" : "done";
    case "error":
      return zh ? "错误" : "error";
    case "cancelled":
      return zh ? "取消" : "cancelled";
    default:
      return zh ? "运行中" : "running";
  }
}

function typeLabel(agentType: string, zh: boolean): string {
  const key = agentType.toLowerCase();
  if (zh) {
    if (key === "explore") return "探索";
    if (key === "plan") return "计划";
    if (key === "general-purpose" || key === "general") return "通用";
    if (key === "subagent") return "子代理";
  }
  return agentType;
}

function SubagentRow({
  agent,
  index,
  zh,
  clickable,
  dimmed,
}: {
  agent: ActiveSubagent;
  index: number;
  zh: boolean;
  clickable: boolean;
  dimmed?: boolean;
}) {
  const tone = subagentTone(agent, index);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (agent.status === "done" || agent.status === "error" || agent.status === "cancelled") {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [agent.status]);
  const elapsed = Math.max(0, now - agent.startedAt);

  const body = (
    <>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${dimmed ? "opacity-50" : "animate-pulse-dot"}`} />
      <Icon name="layers" size={11} className={`shrink-0 ${tone.text}`} />
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] ${tone.text}`}
      >
        {typeLabel(agent.agentType, zh)}
      </span>
      <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] leading-none ${tone.text}`}>
        {agent.title}
      </span>
      {agent.detail && agent.detail !== agent.title && (
        <span className="hidden max-w-[28%] truncate font-mono text-[10.5px] text-faint sm:inline">
          {agent.detail}
        </span>
      )}
      <span className="tnum shrink-0 text-[10px] text-faint">{fmtDuration(elapsed)}</span>
      <span className={`shrink-0 font-mono text-[9.5px] uppercase tracking-wide ${tone.text} opacity-70`}>
        {statusLabel(agent.status, zh)}
      </span>
    </>
  );

  const className = `flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left ${tone.border} ${tone.bg} ${dimmed ? "opacity-70" : ""} ${clickable ? "cursor-pointer hover:brightness-110" : ""}`;

  if (!clickable) {
    return (
      <div className={className} title={[agent.title, agent.detail].filter(Boolean).join("\n")}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={[agent.title, agent.detail, zh ? "点击定位到时间线" : "Click to locate in timeline"]
        .filter(Boolean)
        .join("\n")}
      onClick={() => focusTimelineBlock(agent.blockId)}
    >
      {body}
    </button>
  );
}

export function ActiveProcessBar({ session, zh }: { session: Session | null | undefined; zh: boolean }) {
  const v2 = useIsFeatureEnabled("agentStripV2");
  const agents = extractActiveSubagents(session);
  const recent = useMemo(
    () => (v2 ? extractRecentSubagents(session, 5) : []),
    [session, v2],
  );
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);
  const openSession = useDesktop((s) => s.openSession);
  const [showHistory, setShowHistory] = useState(false);

  const hint = useMemo(() => {
    if (!v2) return null;
    const snaps = Object.values(sessions).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
    }));
    return concurrentSoftHint({
      sessions: snaps,
      activeId,
      activeSubagentCount: agents.length,
    });
  }, [v2, sessions, activeId, agents.length]);

  const otherRunning = useMemo(() => {
    if (!v2 || !hint) return [];
    return hint.otherRunningIds
      .map((id) => sessions[id])
      .filter(Boolean)
      .slice(0, 6);
  }, [v2, hint, sessions]);

  if (agents.length === 0 && (!v2 || (recent.length === 0 && !hint?.show && otherRunning.length === 0))) {
    return null;
  }

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line2 bg-raise shadow-[var(--shadow-float)] animate-fade-up">
      {v2 && hint?.show && (
        <div className="border-b border-line bg-gold/5 px-3 py-1.5 font-mono text-[10.5px] text-gold">
          {concurrentHintText(hint, zh)}
        </div>
      )}

      {v2 && otherRunning.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span className="text-[10.5px] text-faint">{zh ? "其他忙碌会话" : "Other busy sessions"}</span>
          {otherRunning.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => void openSession(s.id)}
              className="chip !h-6 !text-[10px]"
              title={s.title}
            >
              {s.title.slice(0, 24) || s.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      {agents.length > 0 && (
        <>
          <div className="flex h-7 items-center justify-between border-b border-line px-3">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-gold" />
              <span className="text-[11.5px] font-medium text-mute">
                {zh ? `子代理 ${agents.length}` : `Subagents ${agents.length}`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {agents.map((agent, index) => {
                const tone = subagentTone(agent, index);
                return (
                  <span
                    key={agent.id}
                    className={`flex items-center gap-1 font-mono text-[9.5px] ${tone.text}`}
                    title={agent.title}
                  >
                    <span className={`h-1 w-1 rounded-full ${tone.dot}`} />
                    {typeLabel(agent.agentType, zh)}
                  </span>
                );
              })}
              {v2 && recent.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="text-[10px] text-dim hover:text-fg2"
                >
                  {showHistory ? (zh ? "收起历史" : "Hide history") : (zh ? "历史" : "History")}
                </button>
              )}
            </div>
          </div>
          <div className="max-h-36 divide-y divide-line overflow-y-auto">
            {agents.map((agent, index) => (
              <SubagentRow
                key={agent.id}
                agent={agent}
                index={index}
                zh={zh}
                clickable={v2}
              />
            ))}
          </div>
        </>
      )}

      {v2 && showHistory && recent.length > 0 && (
        <div className="border-t border-line">
          <div className="px-3 py-1 text-[10px] text-faint">
            {zh ? "最近子代理" : "Recent subagents"}
          </div>
          <div className="max-h-28 divide-y divide-line overflow-y-auto">
            {recent.map((agent, index) => (
              <SubagentRow
                key={`h-${agent.id}`}
                agent={agent}
                index={index}
                zh={zh}
                clickable
                dimmed
              />
            ))}
          </div>
        </div>
      )}

      {v2 && agents.length === 0 && recent.length > 0 && (
        <div className="flex h-7 items-center justify-between border-b border-line px-3">
          <span className="text-[11.5px] font-medium text-mute">
            {zh ? "子代理历史" : "Subagent history"}
          </span>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="text-[10px] text-dim hover:text-fg2"
          >
            {showHistory ? (zh ? "收起" : "Hide") : (zh ? "展开" : "Show")}
          </button>
        </div>
      )}
      {v2 && agents.length === 0 && showHistory && recent.length > 0 && (
        <div className="max-h-28 divide-y divide-line overflow-y-auto">
          {recent.map((agent, index) => (
            <SubagentRow
              key={`h2-${agent.id}`}
              agent={agent}
              index={index}
              zh={zh}
              clickable
              dimmed
            />
          ))}
        </div>
      )}
    </div>
  );
}

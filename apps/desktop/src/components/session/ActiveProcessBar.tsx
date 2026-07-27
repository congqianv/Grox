/* Live subagent strip shown above the composer. */

import { useEffect, useState } from "react";
import type { Session } from "../../bridge/types";
import {
  extractActiveSubagents,
  subagentTone,
  type ActiveSubagent,
} from "../../lib/activeProcesses";
import { fmtDuration } from "../../lib/format";
import { Icon } from "../fx/Icon";

function statusLabel(status: ActiveSubagent["status"], zh: boolean): string {
  switch (status) {
    case "awaiting_permission":
      return zh ? "待批准" : "gated";
    case "pending":
      return zh ? "排队" : "queued";
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
}: {
  agent: ActiveSubagent;
  index: number;
  zh: boolean;
}) {
  const tone = subagentTone(agent, index);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - agent.startedAt);

  return (
    <div
      className={`flex items-center gap-2 border-l-2 px-2.5 py-1.5 ${tone.border} ${tone.bg}`}
      title={[agent.title, agent.detail].filter(Boolean).join("\n")}
    >
      <span className={`h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full ${tone.dot}`} />
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
    </div>
  );
}

export function ActiveProcessBar({ session, zh }: { session: Session | null | undefined; zh: boolean }) {
  const agents = extractActiveSubagents(session);
  if (agents.length === 0) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line2 bg-raise shadow-[var(--shadow-float)] animate-fade-up">
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
        </div>
      </div>
      <div className="max-h-36 divide-y divide-line overflow-y-auto">
        {agents.map((agent, index) => (
          <SubagentRow key={agent.id} agent={agent} index={index} zh={zh} />
        ))}
      </div>
    </div>
  );
}

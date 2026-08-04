/* Soft concurrency hint only — full subagent UI lives in SubagentRail (right). */

import { useMemo } from "react";
import type { Session } from "../../bridge/types";
import { extractActiveSubagents } from "../../lib/activeProcesses";
import {
  concurrentHintText,
  concurrentSoftHint,
} from "../../lib/concurrentSessions";
import { useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";

/**
 * Thin banner above composer when parallelism is high.
 * Detailed subagent progress/history is in the right-hand SubagentRail.
 */
export function ActiveProcessBar({ session, zh }: { session: Session | null | undefined; zh: boolean }) {
  const v2 = useIsFeatureEnabled("agentStripV2");
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);

  const agents = extractActiveSubagents(session);

  const hint = useMemo(() => {
    if (!v2) return null;
    return concurrentSoftHint({
      sessions: Object.values(sessions).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
      })),
      activeId,
      activeSubagentCount: agents.length,
    });
  }, [v2, sessions, activeId, agents.length]);

  // Legacy (flag off): keep a minimal live count so we do not hide activity entirely.
  if (!v2) {
    if (agents.length === 0) return null;
    return (
      <div className="mb-2 rounded-lg border border-line2 bg-raise px-3 py-1.5 font-mono text-[11px] text-mute">
        {zh ? `子代理 ${agents.length} 运行中` : `${agents.length} subagent(s) running`}
      </div>
    );
  }

  // With agentStripV2, SubagentRail already shows soft concurrency detail.
  // Only surface the higher "soft" threshold here to avoid double banners at info.
  if (!hint?.show || hint.level !== "soft") return null;

  return (
    <div className="mb-2 rounded-lg border border-gold/25 bg-gold/5 px-3 py-1.5 font-mono text-[11px] text-gold">
      {concurrentHintText(hint, zh)}
      <span className="ml-2 text-faint">
        {zh ? "详情见右侧面板" : "See right rail"}
      </span>
    </div>
  );
}

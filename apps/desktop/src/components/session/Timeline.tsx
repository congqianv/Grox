import { memo, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Session, SessionBlock } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { AssistantMsg, SystemEvent, UserMsg } from "./blocks";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanCard } from "./PlanCard";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { TurnChangeCard } from "./TurnChangeCard";

interface Turn {
  id: string;
  blocks: SessionBlock[];
  promptIndex: number;
}

interface RequestMarker {
  id: string;
  index: number;
  position: number;
  prompt: string;
  response: string;
}

function compactPreview(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function requestPreview(
  turn: Turn,
  language: string,
): Omit<RequestMarker, "index" | "position"> | undefined {
  const user = turn.blocks.find(
    (block): block is Extract<SessionBlock, { type: "user" }> => block.type === "user",
  );
  if (!user) return undefined;
  const assistant = turn.blocks
    .filter(
      (block): block is Extract<SessionBlock, { type: "assistant" }> =>
        block.type === "assistant",
    )
    .at(-1);
  return {
    id: turn.id,
    prompt: compactPreview(user.text, 92),
    response: assistant?.text.trim()
      ? compactPreview(assistant.text, 128)
      : language === "zh-CN"
        ? "正在等待 Grok 的回复…"
        : "Waiting for Grok's reply…",
  };
}

/** Upstream dandandujie/Grox: left rail for quick jump between user requests. */
function RequestRail({
  markers,
  language,
  onJump,
}: {
  markers: RequestMarker[];
  language: string;
  onJump(id: string): void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const markerNodes = useRef(new Map<string, HTMLButtonElement>());
  const waveFrame = useRef<number | null>(null);
  const pointerPosition = useRef<number | null>(null);

  const updateWave = (position: number | null) => {
    pointerPosition.current = position;
    if (waveFrame.current !== null) return;
    waveFrame.current = requestAnimationFrame(() => {
      waveFrame.current = null;
      const point = pointerPosition.current;
      for (const marker of markers) {
        const node = markerNodes.current.get(marker.id);
        if (!node) continue;
        const wave =
          point === null ? 0 : Math.max(0, 1 - Math.abs(marker.position - point) / 17);
        node.style.setProperty("--request-rail-wave", wave.toFixed(3));
      }
    });
  };

  useEffect(
    () => () => {
      if (waveFrame.current !== null) cancelAnimationFrame(waveFrame.current);
    },
    [],
  );

  if (markers.length === 0) return null;

  return (
    <nav
      className="request-rail"
      aria-label={language === "zh-CN" ? "请求导航" : "Request navigation"}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.height <= 0) return;
        updateWave(Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100)));
      }}
      onPointerLeave={() => {
        updateWave(null);
        setHoveredId(null);
      }}
    >
      <span className="request-rail__spine" aria-hidden="true" />
      {markers.map((marker) => {
        const hovering = hoveredId === marker.id;
        const style = {
          top: `${marker.position}%`,
          "--request-rail-hovered": hovering ? "1" : "0",
        } as CSSProperties;
        const label =
          language === "zh-CN" ? `请求 ${marker.index + 1}` : `Request ${marker.index + 1}`;
        return (
          <button
            key={marker.id}
            type="button"
            className={`request-rail__marker ${hovering ? "is-hovered" : ""}`}
            style={style}
            ref={(node) => {
              if (node) markerNodes.current.set(marker.id, node);
              else markerNodes.current.delete(marker.id);
            }}
            onPointerEnter={() => setHoveredId(marker.id)}
            onFocus={() => setHoveredId(marker.id)}
            onBlur={() => setHoveredId(null)}
            onClick={() => onJump(marker.id)}
            aria-label={`${label}: ${marker.prompt}`}
          >
            <span className="request-rail__bar" aria-hidden="true" />
            {hovering && (
              <span className="request-rail__tooltip" role="tooltip">
                <span className="request-rail__tooltip-label">{label}</span>
                <span className="request-rail__tooltip-prompt">{marker.prompt}</span>
                <span className="request-rail__tooltip-response">{marker.response}</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** True when `next` is a stream-retry twin of `prev` (same/fuller body, not new content). */
function isRetryTwinText(prev: string, next: string): boolean {
  const a = prev.trim();
  const b = next.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // Retried stream often restarts from the top; longer text usually contains the shorter prefix.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 40) return false;
  if (longer.startsWith(shorter.slice(0, Math.min(shorter.length, 200)))) return true;
  // High overlap on the leading window ≈ duplicate full answers stacked by retry.
  const window = Math.min(120, shorter.length);
  return longer.includes(shorter.slice(0, window)) && shorter.length / longer.length > 0.55;
}

function groupTurns(blocks: SessionBlock[]): Turn[] {
  const turns: Turn[] = [];
  let promptIndex = -1;
  for (const block of blocks) {
    if (block.type === "user") {
      promptIndex += 1;
      turns.push({ id: block.id, blocks: [block], promptIndex });
    } else if (turns.length === 0) turns.push({ id: block.id, blocks: [block], promptIndex: -1 });
    else turns[turns.length - 1].blocks.push(block);
  }
  return turns;
}

function renderBlock(block: SessionBlock, sessionId: string, processing = false) {
  switch (block.type) {
    case "user": return <UserMsg key={block.id} block={block} />;
    case "assistant": return <AssistantMsg key={block.id} block={block} process={processing} />;
    case "thinking": return <ThinkingBlock key={block.id} block={block} processing={processing} />;
    case "tool": return <ToolCallCard key={block.id} block={block} />;
    case "plan": return <PlanCard key={block.id} block={block} />;
    case "permission": return <PermissionCard key={block.id} block={block} sessionId={sessionId} />;
    case "question": return <QuestionCard key={block.id} block={block} />;
    case "system": return <SystemEvent key={block.id} block={block} />;
  }
}

function ToolBatch({ blocks }: { blocks: Extract<SessionBlock, { type: "tool" }>[] }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const commands = blocks.filter((block) => block.call.kind === "execute" || block.call.kind === "terminal").length;
  const edits = blocks.filter((block) => ["edit", "write", "delete", "move"].includes(block.call.kind)).length;
  const busy = blocks.some((block) => ["pending", "running", "awaiting_permission"].includes(block.call.status));
  const summary = language === "zh-CN"
    ? edits && commands ? `编辑了文件并运行了 ${commands} 个命令` : commands ? `运行了 ${commands} 个命令` : edits ? `编辑了 ${edits} 个文件` : `调用了 ${blocks.length} 个工具`
    : edits && commands ? `Edited files and ran ${commands} commands` : commands ? `Ran ${commands} commands` : edits ? `Edited ${edits} files` : `Used ${blocks.length} tools`;

  return (
    <div className="process-tool-batch mb-2 overflow-hidden">
      <button onClick={() => setOpen((value) => !value)} className="process-tool-toggle">
        <span className={`process-node ${busy ? "is-live" : "is-done"}`} aria-hidden="true" />
        <Icon name={commands ? "terminal" : edits ? "edit" : "bolt"} size={11} className="shrink-0 text-dim" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg2" title={summary}>{summary}</span>
        {busy && <span className="lbl lbl-acc shrink-0 !text-[9px]">{language === "zh-CN" ? "执行中" : "RUNNING"}</span>}
        <Icon name="chevronRight" size={9} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[6px] max-h-56 overflow-y-auto border-l border-line2 pb-1 pl-4 pt-1">{blocks.map((block) => <ToolCallCard key={block.id} block={block} />)}</div>}
    </div>
  );
}

function RenderSequence({ blocks, sessionId, processing }: { blocks: SessionBlock[]; sessionId: string; processing: boolean }) {
  const output: React.ReactNode[] = [];
  for (let index = 0; index < blocks.length;) {
    if (blocks[index].type !== "tool") {
      output.push(renderBlock(blocks[index], sessionId, processing));
      index += 1;
      continue;
    }
    const tools: Extract<SessionBlock, { type: "tool" }>[] = [];
    while (index < blocks.length && blocks[index].type === "tool") {
      tools.push(blocks[index] as Extract<SessionBlock, { type: "tool" }>);
      index += 1;
    }
    output.push(<ToolBatch key={`tools-${tools[0].id}`} blocks={tools} />);
  }
  return <>{output}</>;
}

interface TurnGroupProps {
  turn: Turn;
  sessionId: string;
  status: Session["status"];
  active: boolean;
}

function TurnGroup({ turn, sessionId, status, active }: TurnGroupProps) {
  const { language } = useI18n();
  // Only the latest in-flight turn uses live process chrome. Historical turns
  // must stay in the collapsed "Processed" view even while a newer turn runs —
  // otherwise prior answers reappear as thinking/process text.
  const complete = !active || status === "idle";
  const [processOpen, setProcessOpen] = useState(!complete);
  const user = turn.blocks.find((block): block is Extract<SessionBlock, { type: "user" }> => block.type === "user");

  useEffect(() => {
    if (complete) setProcessOpen(false);
  }, [complete]);

  if (!complete) {
    const liveBlocks = turn.blocks.filter((block) => block !== user);
    return (
      <section className="timeline-turn mb-8">
        {user && (
          <UserMsg
            block={user}
            rewindPromptIndex={turn.promptIndex >= 0 ? turn.promptIndex : undefined}
            canEdit={false}
          />
        )}
        <div className="process-live mb-5">
          <div className="mb-3 flex min-h-8 items-center gap-2">
            <BlackHole size={15} spin />
            <span className="text-[10.5px] font-medium text-fg2">{status === "awaiting_permission" ? (language === "zh-CN" ? "等待批准" : "Awaiting approval") : status === "awaiting_input" ? (language === "zh-CN" ? "等待你的回答" : "Awaiting input") : (language === "zh-CN" ? "Grok 正在处理" : "Grok is working")}</span>
            <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />
            <span className="font-mono text-[9px] tracking-[0.08em] text-faint">{language === "zh-CN" ? `${liveBlocks.length} 条事件` : `${liveBlocks.length} events`}</span>
          </div>
          <div className="process-sequence process-rail ml-[7px] pl-5">
            {liveBlocks.length > 0 ? (
              <RenderSequence blocks={liveBlocks} sessionId={sessionId} processing />
            ) : (
              <div className="mb-3 flex items-center gap-2 text-[10.5px] text-dim">
                <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc-dim" />
                {language === "zh-CN" ? "等待模型返回第一个事件…" : "Waiting for the first model event…"}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  const unresolved = turn.blocks.filter((block) => (block.type === "permission" && !block.resolved) || (block.type === "question" && !block.response));
  // Agent turns emit many assistant segments (narration between tools). The wire
  // closes each segment before the next tool, so only showing assistants.at(-1)
  // hides most of the answer inside the collapsed "Processed" fold.
  const assistants = turn.blocks.filter((block): block is Extract<SessionBlock, { type: "assistant" }> => block.type === "assistant");
  const process = turn.blocks.filter(
    (block) => block !== user && block.type !== "assistant" && !unresolved.includes(block),
  );
  const toolCount = process.filter((block) => block.type === "tool").length;
  const thoughts = process.filter((block): block is Extract<SessionBlock, { type: "thinking" }> => block.type === "thinking");
  const thoughtCount = thoughts.length;
  const elapsed = thoughts.reduce((sum, block) => sum + (block.elapsedMs ?? 0), 0);
  const otherEventCount = process.length - toolCount - thoughtCount;
  const summaryParts = language === "zh-CN"
    ? [
        thoughtCount ? `${thoughtCount} 段思考` : "",
        toolCount ? `${toolCount} 个工具` : "",
        otherEventCount ? `${otherEventCount} 条运行事件` : "",
      ].filter(Boolean)
    : [
        thoughtCount ? `${thoughtCount} thoughts` : "",
        toolCount ? `${toolCount} tools` : "",
        otherEventCount ? `${otherEventCount} runtime events` : "",
      ].filter(Boolean);
  const processSummary = summaryParts.length > 0
    ? summaryParts.join(" · ")
    : language === "zh-CN" ? "服务商未公开思考或工具过程" : "Provider did not expose reasoning or tool activity";

  // Merge every assistant segment into one visible reply so intermediate
  // progress notes are not mistaken for a truncated final answer.
  // Drop near-duplicate twins left by pre-fix stream retries (same body
  // re-rendered into a second bubble) so the join does not show the answer twice.
  const answerBlock = (() => {
    if (assistants.length === 0) return null;
    const collapsed: typeof assistants = [];
    for (const block of assistants) {
      const prev = collapsed[collapsed.length - 1];
      const cur = block.text.trim();
      if (!cur) continue;
      if (prev && isRetryTwinText(prev.text, cur)) {
        collapsed[collapsed.length - 1] = block;
        continue;
      }
      collapsed.push(block);
    }
    if (collapsed.length === 0) return assistants.at(-1) ?? null;
    if (collapsed.length === 1) return collapsed[0];
    const text = collapsed.map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    const last = collapsed[collapsed.length - 1];
    return {
      type: "assistant" as const,
      id: last.id,
      text: text || last.text,
      ts: last.ts,
      streaming: false,
    };
  })();

  const finishedAt = Math.max(user?.ts ?? 0, ...turn.blocks.map((block) => block.type === "tool" ? block.call.endedAt ?? block.ts : block.ts));
  const turnElapsed = user && finishedAt > user.ts ? finishedAt - user.ts : 0;

  return (
    <section className="timeline-turn mb-8">
      {user && (
        <UserMsg
          block={user}
          rewindPromptIndex={turn.promptIndex >= 0 ? turn.promptIndex : undefined}
          canEdit={status === "idle" && turn.promptIndex >= 0}
        />
      )}
      <div className="process-complete mb-5">
        <button className="process-summary" onClick={() => setProcessOpen((open) => !open)}>
          <Icon name={processOpen ? "chevronDown" : "chevronRight"} size={9} className="shrink-0 text-dim" />
          <span className="shrink-0 text-[10.5px] font-medium text-fg2">{language === "zh-CN" ? "已处理" : "Processed"}</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-dim" title={processSummary}>{processSummary}{elapsed ? ` · ${(elapsed / 1000).toFixed(1)}s` : ""}</span>
          <Icon name="check" size={9} className="text-green" />
        </button>
        {processOpen && (
          <div className="process-sequence process-rail ml-[7px] mt-2 border-l border-line2 pb-1 pl-5 pt-2">
            {process.length > 0 ? (
              <RenderSequence blocks={process} sessionId={sessionId} processing={false} />
            ) : (
              <p className="mb-3 text-[10.5px] leading-relaxed text-dim">{language === "zh-CN" ? "本轮 API 只返回了最终答复；无法据此判断服务商内部是否调用了工具。" : "The API returned only a final answer; provider-internal tool usage cannot be determined from this response."}</p>
            )}
          </div>
        )}
        {turnElapsed > 0 && <div className="turn-elapsed"><span>{language === "zh-CN" ? `已处理 ${turnElapsed < 1000 ? `${turnElapsed}ms` : `${(turnElapsed / 1000).toFixed(turnElapsed < 10_000 ? 1 : 0)}s`}` : `Processed in ${(turnElapsed / 1000).toFixed(1)}s`}</span><i /></div>}
      </div>
      {unresolved.map((block) => renderBlock(block, sessionId))}
      {answerBlock && <AssistantMsg block={answerBlock} />}
      {/* Upstream: summarize file diffs for this turn + review/rewind */}
      <TurnChangeCard blocks={turn.blocks} promptIndex={turn.promptIndex} />
    </section>
  );
}

const MemoTurnGroup = memo(TurnGroup, (previous, next) => {
  if (previous.active !== next.active || previous.sessionId !== next.sessionId) return false;
  // Only the live turn needs session status (canEdit / process chrome).
  if ((previous.active || next.active) && previous.status !== next.status) return false;
  if (previous.turn.blocks.length !== next.turn.blocks.length) return false;
  if (previous.turn.promptIndex !== next.turn.promptIndex) return false;
  return previous.turn.blocks.every((block, index) => block === next.turn.blocks[index]);
});

/**
 * Optional window for *live* ultra-long sessions only.
 * Restored / offline history always shows in full — users should not have to
 * click "show earlier turns" just to read what was already loaded from disk.
 */
const LIVE_TURN_WINDOW = 40;
const STICK_BOTTOM_PX = 48;

/** Stable Footer type — inline `Footer: () => …` remounts Virtuoso chrome every stream tick. */
function TimelineVirtuosoFooter() {
  return <div className="h-8" />;
}

export function Timeline({ session }: { session: Session }) {
  const { language } = useI18n();
  const fullHistoryLoadingId = useDesktop((s) => s.fullHistoryLoadingId);
  const historyLoadMode = useDesktop((s) => s.historyLoadMode);
  const diskHistoryProgress = useDesktop((s) => s.diskHistoryProgress);
  const agentBindStartedAt = useDesktop((s) => s.agentBindStartedAt);
  const loadingFullHistory = fullHistoryLoadingId === session.id;
  const scanProgress =
    diskHistoryProgress?.id === session.id ? diskHistoryProgress : null;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followRef = useRef(true);
  const jumpTimersRef = useRef<number[]>([]);
  const turns = useMemo(() => groupTurns(session.blocks), [session.blocks]);
  /** true = show entire transcript (default for restored history). */
  const [showAll, setShowAll] = useState(true);
  const [bindElapsedSec, setBindElapsedSec] = useState(0);
  // Streaming text length intentionally omitted — Virtuoso followOutput covers growth.
  const hasBlocks = session.blocks.length > 0;
  // Latest turn id — only this row uses live process chrome while the session runs.
  const lastTurnId = turns.at(-1)?.id;
  const isLive = session.status === "running";

  const markers = useMemo<RequestMarker[]>(() => {
    const requests = turns
      .map((turn) => requestPreview(turn, language))
      .filter((marker): marker is Omit<RequestMarker, "index" | "position"> => Boolean(marker));
    if (requests.length === 0) return [];
    return requests.map((marker, index) => ({
      ...marker,
      index,
      // Evenly spaced navigation index (table of contents), not a pixel map.
      position: ((index + 0.5) / requests.length) * 100,
    }));
  }, [language, turns]);

  // Opening / switching: always show full history (scroll sticks to bottom).
  useEffect(() => {
    setShowAll(true);
    followRef.current = true;
  }, [session.id]);

  // Offline scan / cache upgrade may add many older turns — keep them visible.
  useEffect(() => {
    if (!isLive) setShowAll(true);
  }, [session.blocks.length, isLive]);

  // Agent silent-bind elapsed clock (Wave 3 bind timing copy).
  useEffect(() => {
    if (
      !loadingFullHistory ||
      historyLoadMode !== "agent" ||
      !agentBindStartedAt ||
      fullHistoryLoadingId !== session.id
    ) {
      setBindElapsedSec(0);
      return;
    }
    const tick = () =>
      setBindElapsedSec(Math.max(0, Math.floor((Date.now() - agentBindStartedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [
    loadingFullHistory,
    historyLoadMode,
    agentBindStartedAt,
    fullHistoryLoadingId,
    session.id,
  ]);

  const visibleTurns = useMemo(() => {
    // Restored idle sessions: always full. Live stream with huge history: optional window.
    if (showAll || !isLive || turns.length <= LIVE_TURN_WINDOW) return turns;
    return turns.slice(turns.length - LIVE_TURN_WINDOW);
  }, [showAll, turns, isLive]);
  const hiddenCount = turns.length - visibleTurns.length;

  const clearJumpTimers = () => {
    for (const t of jumpTimersRef.current) window.clearTimeout(t);
    jumpTimersRef.current = [];
  };

  const jumpToTurn = (id: string) => {
    // Expand live window if the target is outside the visible slice.
    if (!showAll && !visibleTurns.some((turn) => turn.id === id)) {
      setShowAll(true);
    }
    followRef.current = false;
    clearJumpTimers();
    const run = () => {
      // Index against the list Virtuoso currently renders (or full after expand).
      const list = showAll || turns.length <= LIVE_TURN_WINDOW ? turns : visibleTurns;
      // After setShowAll, prefer full turns once expanded data commits.
      const target = turns.findIndex((turn) => turn.id === id);
      const index = target >= 0 && (showAll || turns.length <= LIVE_TURN_WINDOW)
        ? target
        : list.findIndex((turn) => turn.id === id);
      if (index < 0) return;
      virtuosoRef.current?.scrollToIndex({
        index,
        align: "start",
        behavior: "auto",
        offset: -48,
      });
    };
    run();
    jumpTimersRef.current.push(window.setTimeout(run, 40));
    jumpTimersRef.current.push(window.setTimeout(run, 160));
  };

  const scrollToBottom = (force = false) => {
    if (!force && !followRef.current) return false;
    if (visibleTurns.length === 0) return false;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: force ? "auto" : "smooth",
    });
    return true;
  };

  // Stick to bottom only on open/switch — never yank on every block_add (user reading up).
  useEffect(() => {
    clearJumpTimers();
    if (!hasBlocks) return;
    followRef.current = true;
    scrollToBottom(true);
    // Delayed remeasure must honor unfollow if the user scrolled/jumped early.
    const t1 = window.setTimeout(() => {
      if (followRef.current) scrollToBottom(true);
    }, 40);
    const t2 = window.setTimeout(() => {
      if (followRef.current) scrollToBottom(true);
    }, 160);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      clearJumpTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: session open only
  }, [session.id]);

  if (!hasBlocks) {
    if (loadingFullHistory && historyLoadMode === "disk") {
      const pct = scanProgress?.percent ?? 0;
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 pb-24">
          <BlackHole size={40} spin />
          <div className="w-full max-w-sm text-center">
            <p className="text-[14px] text-mute">
              {language === "zh-CN"
                ? `正在从磁盘加载历史… ${pct}%`
                : `Loading history from disk… ${pct}%`}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line/60">
              <div
                className="h-full rounded-full bg-acc/80 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
              />
            </div>
            {scanProgress && scanProgress.totalBytes > 0 && (
              <p className="mt-2 text-[11px] text-faint">
                {(scanProgress.bytesRead / (1024 * 1024)).toFixed(1)} /{" "}
                {(scanProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB
              </p>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-24">
        <BlackHole size={40} spin="slow" />
        <div className="text-center">
          <p className="text-[15px] text-mute">{language === "zh-CN" ? "准备好了。" : "Ready when you are."}</p>
          <p className="mt-1.5 text-[13px] text-faint">
            {language === "zh-CN" ? "在下方输入你的第一个请求" : "Type your first message below"}
          </p>
        </div>
      </div>
    );
  }

  const agentBindLabel =
    language === "zh-CN"
      ? bindElapsedSec > 0
        ? `首次发送：静默绑定 Agent 上下文中… 已等待 ${bindElapsedSec}s（不卡界面）`
        : "首次发送：静默绑定 Agent 上下文中（不卡界面）…"
      : bindElapsedSec > 0
        ? `First send: binding agent context… ${bindElapsedSec}s elapsed`
        : "First send: silently binding agent context…";

  // Stable component types for Virtuoso chrome — only rebuild when banner inputs change
  // (not on every streaming block_patch).
  const virtuosoComponents = useMemo(
    () => ({
      Header: function TimelineListHeader() {
        return (
          <div className="mx-auto max-w-[860px] px-8 pt-8">
            {loadingFullHistory && (
              <div className="mb-4 rounded-md border border-line/80 bg-raise/50 px-3 py-2.5">
                <div className="flex items-center justify-center gap-2 text-[11.5px] text-mute">
                  <BlackHole size={14} spin />
                  <span className="min-w-0 text-center">
                    {historyLoadMode === "disk"
                      ? language === "zh-CN"
                        ? scanProgress
                          ? `正在从磁盘补全历史… ${scanProgress.percent}%` +
                            (scanProgress.totalBytes > 0
                              ? ` · ${(scanProgress.bytesRead / (1024 * 1024)).toFixed(1)}/${(scanProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB`
                              : "") +
                            (scanProgress.blocks > 0 ? ` · ${scanProgress.blocks} 条` : "")
                          : "正在从磁盘补全完整历史（工具调用等）… 可切换其他对话"
                        : scanProgress
                          ? `Loading history from disk… ${scanProgress.percent}%` +
                            (scanProgress.totalBytes > 0
                              ? ` · ${(scanProgress.bytesRead / (1024 * 1024)).toFixed(1)}/${(scanProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB`
                              : "") +
                            (scanProgress.blocks > 0 ? ` · ${scanProgress.blocks} blocks` : "")
                          : "Loading full history from disk… switching chats is fine"
                      : agentBindLabel}
                  </span>
                </div>
                {historyLoadMode === "disk" && scanProgress && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/60">
                    <div
                      className="h-full rounded-full bg-acc/80 transition-[width] duration-200 ease-out"
                      style={{ width: `${Math.min(100, Math.max(2, scanProgress.percent))}%` }}
                    />
                  </div>
                )}
                {historyLoadMode === "agent" && bindElapsedSec >= 3 && (
                  <p className="mt-1.5 text-center text-[10.5px] text-faint">
                    {language === "zh-CN"
                      ? "大会话绑定可能较久 · 界面仍可滚动与切换对话"
                      : "Large sessions can take a while · UI stays interactive"}
                  </p>
                )}
                {historyLoadMode === "disk" && (
                  <p className="mt-1.5 text-center text-[10.5px] text-faint">
                    {language === "zh-CN"
                      ? "可切换其他对话，不会卡住 · 完成后下次打开会更快"
                      : "You can switch chats · next open will be faster"}
                  </p>
                )}
              </div>
            )}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  followRef.current = false;
                  setShowAll(true);
                }}
                className="mb-6 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raise/60 py-2 text-[12px] text-mute transition-colors hover:bg-high hover:text-fg2"
              >
                {language === "zh-CN"
                  ? `显示更早的 ${hiddenCount} 轮对话`
                  : `Show ${hiddenCount} earlier turns`}
              </button>
            )}
          </div>
        );
      },
      Footer: TimelineVirtuosoFooter,
    }),
    [
      loadingFullHistory,
      historyLoadMode,
      scanProgress,
      agentBindLabel,
      bindElapsedSec,
      language,
      hiddenCount,
    ],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <Virtuoso
        key={session.id}
        ref={virtuosoRef}
        className="h-full min-w-0 flex-1"
        data={visibleTurns}
        // Open at the end so restored history does not flash top→bottom.
        initialTopMostItemIndex={
          visibleTurns.length > 0
            ? { index: visibleTurns.length - 1, align: "end" }
            : 0
        }
        defaultItemHeight={280}
        increaseViewportBy={{ top: 600, bottom: 800 }}
        atBottomThreshold={STICK_BOTTOM_PX}
        atBottomStateChange={(atBottom) => {
          followRef.current = atBottom;
        }}
        followOutput={() => {
          // Only the follow flag — atBottom alone must not re-stick after RequestRail jump.
          if (!followRef.current) return false;
          // Instant follow while live — "smooth" stacks animation jank under tokens.
          return isLive ? true : "auto";
        }}
        computeItemKey={(_index, turn) => turn.id}
        components={virtuosoComponents}
        itemContent={(_index, turn) => {
          const active = turn.id === lastTurnId;
          return (
            <div className="mx-auto max-w-[860px] px-8">
              <MemoTurnGroup
                turn={turn}
                sessionId={session.id}
                // Historical turns always "idle" for memo — live status only on active.
                status={active ? session.status : "idle"}
                active={active}
              />
            </div>
          );
        }}
      />
      <RequestRail markers={markers} language={language} onJump={jumpToTurn} />
    </div>
  );
}

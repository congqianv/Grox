import {
  memo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session, SessionBlock } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { isPrimerText } from "../../lib/planPrimer";
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

/**
 * Group blocks into operator turns.
 * Mid-turn interjections (`user.interjected`) stay inside the current turn so
 * the live process chrome does not collapse and yank the scroller through history.
 */
export function groupTurns(blocks: SessionBlock[]): Turn[] {
  const turns: Turn[] = [];
  let promptIndex = -1;
  for (const block of blocks) {
    // Hide plan primers (host inject / legacy SuperGrok history).
    if (block.type === "user" && isPrimerText(block.text)) continue;
    if (block.type === "user") {
      // Same-turn 插话: append, do not open a new turn / promptIndex.
      if (block.interjected && turns.length > 0) {
        turns[turns.length - 1].blocks.push(block);
        continue;
      }
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
    case "question": return <QuestionCard key={block.id} block={block} sessionId={sessionId} />;
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
    const block = blocks[index];
    // Mid-turn 插话: full-width user bubble, break out of the process rail indent.
    if (block.type === "user") {
      output.push(
        <div key={block.id} className="relative -ml-5 mb-1 pl-0">
          {renderBlock(block, sessionId, processing)}
        </div>,
      );
      index += 1;
      continue;
    }
    if (block.type !== "tool") {
      output.push(renderBlock(block, sessionId, processing));
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
  // Primary operator prompt (not mid-turn 插话) for rewind / collapse chrome.
  const user = turn.blocks.find(
    (block): block is Extract<SessionBlock, { type: "user" }> =>
      block.type === "user" && !block.interjected,
  );

  // Collapse before paint so becoming inactive never flashes full process height
  // (that flash + follow-pin is what felt like "scroll through old history").
  useLayoutEffect(() => {
    if (complete) setProcessOpen(false);
  }, [complete]);

  if (!complete) {
    // Keep interjections in chronological order inside the live rail.
    const liveBlocks = turn.blocks.filter((block) => block !== user);
    const eventCount = liveBlocks.filter((block) => block.type !== "user").length;
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
            <span className="font-mono text-[9px] tracking-[0.08em] text-faint">{language === "zh-CN" ? `${eventCount} 条事件` : `${eventCount} events`}</span>
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
  const interjections = turn.blocks.filter(
    (block): block is Extract<SessionBlock, { type: "user" }> =>
      block.type === "user" && Boolean(block.interjected),
  );
  const process = turn.blocks.filter(
    (block) =>
      block !== user &&
      block.type !== "assistant" &&
      !(block.type === "user" && block.interjected) &&
      !unresolved.includes(block),
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
      {interjections.map((block) => (
        <UserMsg key={block.id} block={block} canEdit={false} />
      ))}
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
/** Distance from bottom (px) that still counts as "stuck" for auto-follow. */
const STICK_BOTTOM_PX = 80;

export function Timeline({ session }: { session: Session }) {
  const { language } = useI18n();
  const fullHistoryLoadingId = useDesktop((s) => s.fullHistoryLoadingId);
  const historyLoadMode = useDesktop((s) => s.historyLoadMode);
  const diskHistoryProgress = useDesktop((s) => s.diskHistoryProgress);
  const agentBindStartedAt = useDesktop((s) => s.agentBindStartedAt);
  const loadingFullHistory = fullHistoryLoadingId === session.id;
  const scanProgress =
    diskHistoryProgress?.id === session.id ? diskHistoryProgress : null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /**
   * R25: plain overflow list (no Virtuoso). Tall markdown / CU tables destroy
   * virtual-list height estimates (defaultItemHeight ≪ real), so remeasure
   * rubber-bands the viewport even with followOutput=false. Native scroll keeps
   * scrollTop stable when content below grows; we only pin when follow is on.
   */
  const followRef = useRef(true);
  const jumpTimersRef = useRef<number[]>([]);
  const turns = useMemo(() => groupTurns(session.blocks), [session.blocks]);
  /** true = show entire transcript (default for restored history). */
  const [showAll, setShowAll] = useState(true);
  const [bindElapsedSec, setBindElapsedSec] = useState(0);
  /** UI: show "jump to latest" when user has unfollowed. */
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const hasBlocks = session.blocks.length > 0;
  // Latest turn id — only this row uses live process chrome while the session runs.
  const lastTurnId = turns.at(-1)?.id;
  // Follow stream during tool turns AND while waiting for operator input so
  // permission/question cards are not left off-screen (R4 M1).
  const isLive =
    session.status === "running" ||
    session.status === "awaiting_permission" ||
    session.status === "awaiting_input";

  /**
   * Fingerprint of list growth / stream tokens so follow pin can re-run.
   * Prefer the live stream head (streaming assistant / live thinking / running tool),
   * not only the last array entry — an interjected user bubble can sit after the
   * stream head while tokens still grow on an earlier block.
   */
  const stickKey = useMemo(() => {
    const blocks = session.blocks;
    if (blocks.length === 0) return "0";
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.type === "assistant" && block.streaming) {
        return `live-a:${blocks.length}:${block.id}:${block.text.length}`;
      }
      if (block.type === "thinking" && block.live) {
        return `live-t:${blocks.length}:${block.id}:${block.text.length}`;
      }
      if (
        block.type === "tool" &&
        (block.call.status === "running" ||
          block.call.status === "pending" ||
          block.call.status === "awaiting_permission")
      ) {
        return `live-tool:${blocks.length}:${block.id}:${block.call.status}:${block.call.output?.length ?? 0}`;
      }
    }
    const last = blocks.at(-1)!;
    if (last.type === "assistant" || last.type === "thinking" || last.type === "user") {
      return `${blocks.length}:${last.id}:${last.text.length}:${last.type === "user" && last.interjected ? "i" : ""}`;
    }
    if (last.type === "tool") {
      return `${blocks.length}:${last.id}:${last.call.status}:${last.call.output?.length ?? 0}`;
    }
    return `${blocks.length}:${last.id}:${last.type}`;
  }, [session.blocks]);

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

  const markUserUnfollow = useCallback(() => {
    if (!followRef.current) {
      // Already free — still ensure chrome is visible after first leave-bottom.
      setShowJumpLatest((v) => (v ? v : true));
      return;
    }
    followRef.current = false;
    setShowJumpLatest(true);
  }, []);

  const markFollowLatest = useCallback(() => {
    followRef.current = true;
    setShowJumpLatest(false);
  }, []);

  const scrollToBottom = useCallback((force = false) => {
    if (!force && !followRef.current) return false;
    const el = scrollerRef.current;
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  }, []);

  // Opening / switching: always show full history (scroll sticks to bottom).
  useEffect(() => {
    setShowAll(true);
    followRef.current = true;
    setShowJumpLatest(false);
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
    markUserUnfollow();
    clearJumpTimers();
    const run = () => {
      const root = scrollerRef.current;
      if (!root) return;
      const node = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
      if (!node) return;
      // Offset for sticky chrome: leave a little air above the turn.
      const rootRect = root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      root.scrollTop += nodeRect.top - rootRect.top - 48;
    };
    run();
    jumpTimersRef.current.push(window.setTimeout(run, 40));
    jumpTimersRef.current.push(window.setTimeout(run, 160));
  };

  // Pin to bottom only while follow is on (live stream / session open).
  // useLayoutEffect: pin before paint so mid-turn block inserts cannot flash
  // the viewport at scrollTop=0 / mid-history for a frame.
  useLayoutEffect(() => {
    if (!hasBlocks) return;
    if (!followRef.current) return;
    scrollToBottom(true);
  }, [session.id, stickKey, visibleTurns.length, hasBlocks, scrollToBottom]);

  // Session open: force follow + bottom after late layout (images/fonts).
  useEffect(() => {
    clearJumpTimers();
    if (!hasBlocks) return;
    markFollowLatest();
    scrollToBottom(true);
    const t1 = window.setTimeout(() => {
      if (followRef.current) scrollToBottom(true);
    }, 40);
    const t2 = window.setTimeout(() => {
      if (followRef.current) scrollToBottom(true);
    }, 200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      clearJumpTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: session open only
  }, [session.id]);

  const onScrollerScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > STICK_BOTTOM_PX) {
      markUserUnfollow();
    }
  }, [markUserUnfollow]);

  const onScrollerWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      // deltaY < 0 → scroll content up (read history) — freeze follow immediately.
      if (event.deltaY < 0) markUserUnfollow();
    },
    [markUserUnfollow],
  );

  const onScrollerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.key === "PageUp" ||
        event.key === "Home" ||
        event.key === "ArrowUp" ||
        (event.key === " " && event.shiftKey)
      ) {
        markUserUnfollow();
      }
    },
    [markUserUnfollow],
  );

  // agentBindLabel MUST stay above any early return (hooks order).
  const agentBindLabel =
    language === "zh-CN"
      ? bindElapsedSec > 0
        ? `首次发送：静默绑定 Agent 上下文中… 已等待 ${bindElapsedSec}s（不卡界面）`
        : "首次发送：静默绑定 Agent 上下文中（不卡界面）…"
      : bindElapsedSec > 0
        ? `First send: binding agent context… ${bindElapsedSec}s elapsed`
        : "First send: silently binding agent context…";

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

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        key={session.id}
        ref={scrollerRef}
        className="h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
        // CSS scroll anchoring can fight intentional follow pin; we manage pin ourselves.
        style={{ overflowAnchor: "none" }}
        tabIndex={0}
        onScroll={onScrollerScroll}
        onWheel={onScrollerWheel}
        onKeyDown={onScrollerKeyDown}
      >
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
                markUserUnfollow();
                setShowAll(true);
              }}
              className="mb-6 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raise/60 py-2 text-[12px] text-mute transition-colors hover:bg-high hover:text-fg2"
            >
              {language === "zh-CN"
                ? `显示更早的 ${hiddenCount} 轮对话`
                : `Show ${hiddenCount} earlier turns`}
            </button>
          )}
          {visibleTurns.map((turn) => {
            const active = turn.id === lastTurnId;
            return (
              <div key={turn.id} data-turn-id={turn.id}>
                <MemoTurnGroup
                  turn={turn}
                  sessionId={session.id}
                  // Historical turns always "idle" for memo — live status only on active.
                  status={active ? session.status : "idle"}
                  active={active}
                />
              </div>
            );
          })}
          <div className="h-8" aria-hidden="true" />
        </div>
      </div>
      <RequestRail markers={markers} language={language} onJump={jumpToTurn} />
      {showJumpLatest && (
        <button
          type="button"
          className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line2 bg-raise/95 px-3.5 py-1.5 text-[11.5px] text-fg2 shadow-[var(--shadow-float)] backdrop-blur-sm transition-colors hover:bg-high hover:text-fg"
          onClick={() => {
            markFollowLatest();
            // Double rAF so layout after follow flip settles before pin.
            requestAnimationFrame(() => {
              scrollToBottom(true);
              requestAnimationFrame(() => scrollToBottom(true));
            });
          }}
        >
          {language === "zh-CN" ? "↓ 回到最新" : "↓ Jump to latest"}
        </button>
      )}
    </div>
  );
}

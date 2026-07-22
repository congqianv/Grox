import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionBlock } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { AssistantMsg, SystemEvent, UserMsg } from "./blocks";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanCard } from "./PlanCard";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";

interface Turn {
  id: string;
  blocks: SessionBlock[];
  promptIndex: number;
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
  const answerBlock = (() => {
    if (assistants.length === 0) return null;
    if (assistants.length === 1) return assistants[0];
    const text = assistants
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const last = assistants[assistants.length - 1];
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
              <RenderSequence blocks={process} sessionId={sessionId} processing />
            ) : (
              <p className="mb-3 text-[10.5px] leading-relaxed text-dim">{language === "zh-CN" ? "本轮 API 只返回了最终答复；无法据此判断服务商内部是否调用了工具。" : "The API returned only a final answer; provider-internal tool usage cannot be determined from this response."}</p>
            )}
          </div>
        )}
        {turnElapsed > 0 && <div className="turn-elapsed"><span>{language === "zh-CN" ? `已处理 ${turnElapsed < 1000 ? `${turnElapsed}ms` : `${(turnElapsed / 1000).toFixed(turnElapsed < 10_000 ? 1 : 0)}s`}` : `Processed in ${(turnElapsed / 1000).toFixed(1)}s`}</span><i /></div>}
      </div>
      {unresolved.map((block) => renderBlock(block, sessionId))}
      {answerBlock && <AssistantMsg block={answerBlock} />}
    </section>
  );
}

const MemoTurnGroup = memo(TurnGroup, (previous, next) => {
  if (previous.active !== next.active || previous.sessionId !== next.sessionId) return false;
  // status gates canEdit / process chrome on every turn, not only the live one
  if (previous.status !== next.status) return false;
  if (previous.turn.blocks.length !== next.turn.blocks.length) return false;
  if (previous.turn.promptIndex !== next.turn.promptIndex) return false;
  return previous.turn.blocks.every((block, index) => block === next.turn.blocks[index]);
});

/** Cap initial paint for very long restored transcripts; user can load older turns. */
const INITIAL_TURN_WINDOW = 24;
const STICK_BOTTOM_PX = 120;

export function Timeline({ session }: { session: Session }) {
  const { language } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /** Suppress onScroll while we programmatically pin to bottom. */
  const pinningRef = useRef(false);
  const turns = useMemo(() => groupTurns(session.blocks), [session.blocks]);
  const [showAll, setShowAll] = useState(false);
  const lastBlock = session.blocks.at(-1);
  const signature = `${session.id}:${session.blocks.length}:${lastBlock?.type === "assistant" || lastBlock?.type === "thinking" ? lastBlock.text.length : lastBlock?.id ?? ""}:${session.status}`;
  const hasBlocks = session.blocks.length > 0;

  // Reset window when switching sessions so we don't keep a previous "show all".
  useEffect(() => {
    setShowAll(false);
    followRef.current = true;
  }, [session.id]);

  const visibleTurns = useMemo(() => {
    if (showAll || turns.length <= INITIAL_TURN_WINDOW) return turns;
    return turns.slice(turns.length - INITIAL_TURN_WINDOW);
  }, [showAll, turns]);
  const hiddenCount = turns.length - visibleTurns.length;

  const scrollToBottom = (force = false) => {
    const element = scrollRef.current;
    if (!element) return false;
    if (!force && !followRef.current) return false;
    pinningRef.current = true;
    element.scrollTop = element.scrollHeight;
    // Release pin after the browser has applied scroll and fired any scroll events.
    requestAnimationFrame(() => {
      if (!scrollRef.current) {
        pinningRef.current = false;
        return;
      }
      if (force || followRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      requestAnimationFrame(() => {
        pinningRef.current = false;
      });
    });
    return true;
  };

  // Stick to bottom when the transcript grows / session opens / window expands.
  useEffect(() => {
    if (!hasBlocks) return;
    followRef.current = true;
    scrollToBottom(true);
    const t1 = window.setTimeout(() => scrollToBottom(true), 32);
    const t2 = window.setTimeout(() => scrollToBottom(true), 120);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [session.id, signature, showAll, hiddenCount, hasBlocks]);

  // Content height can change without signature updates (markdown, images, tool expand).
  useEffect(() => {
    if (!hasBlocks) return;
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom(true);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [session.id, hasBlocks]);

  if (!hasBlocks) {
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
    <div
      ref={scrollRef}
      onScroll={() => {
        if (pinningRef.current) return;
        const element = scrollRef.current;
        if (!element) return;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < STICK_BOTTOM_PX;
      }}
      className="flex-1 overflow-y-auto"
    >
      <div ref={contentRef} className="mx-auto max-w-[860px] px-8 py-8">
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => {
              followRef.current = false;
              setShowAll(true);
            }}
            className="mb-6 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raise/60 py-2 text-[12px] text-mute transition-colors hover:bg-high hover:text-fg2"
          >
            {language === "zh-CN" ? `显示更早的 ${hiddenCount} 轮对话` : `Show ${hiddenCount} earlier turns`}
          </button>
        )}
        {visibleTurns.map((turn, index) => {
          const absoluteIndex = hiddenCount + index;
          return (
            <MemoTurnGroup
              key={turn.id}
              turn={turn}
              sessionId={session.id}
              status={session.status}
              active={absoluteIndex === turns.length - 1}
            />
          );
        })}
        <div className="h-2" />
      </div>
    </div>
  );
}

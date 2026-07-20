/* ─────────────────────────────────────────────────────────────────────────
   Core transcript blocks: operator prompt, agent message, system event.
   ───────────────────────────────────────────────────────────────────────── */

import { useLayoutEffect, useRef, useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { fmtClock } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { Markdown } from "../../lib/markdown";
import { BlackHole } from "../fx/BlackHole";
import { Icon } from "../fx/Icon";
import { RewindMenu } from "./RewindMenu";

type UserBlock = Extract<SessionBlock, { type: "user" }>;
type AssistantBlock = Extract<SessionBlock, { type: "assistant" }>;
type SystemBlock = Extract<SessionBlock, { type: "system" }>;

/** Operator prompt — clean bubble; timestamp appears on hover outside the bubble. */
export function UserMsg({ block, rewindPromptIndex }: { block: UserBlock; rewindPromptIndex?: number }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element && !expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [block.text, expanded]);
  return (
    <div className="group/user mb-5 flex animate-fade-up justify-end">
      <div className="relative w-fit max-w-[90%]">
        <div className="rounded-[16px] rounded-br-md bg-high px-4 py-3">
          {block.text ? (
            <p ref={textRef} className={`min-w-0 whitespace-pre-wrap text-[14.5px] leading-[1.7] text-fg select-text ${expanded ? "" : "line-clamp-6"}`}>
              {block.text}
            </p>
          ) : null}
          {block.attachments && block.attachments.length > 0 && (
            <div className={`${block.text ? "mt-2.5" : ""} flex flex-wrap gap-1.5`}>
              {block.attachments.map((attachment) => (
                <span key={attachment.id} className="flex max-w-[220px] items-center gap-1.5 rounded-md bg-raise/80 px-2.5 py-1 text-[11px] text-mute">
                  <Icon name={attachment.kind === "image" ? "square" : "file"} size={9} className={attachment.kind === "image" ? "text-acc" : "text-dim"} />
                  <span className="truncate">{attachment.name}</span>
                  <span className="text-faint">{attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.size / 1024))}K` : `${(attachment.size / 1024 / 1024).toFixed(1)}M`}</span>
                </span>
              ))}
            </div>
          )}
          {(overflowing || expanded || rewindPromptIndex !== undefined) && (
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              <span className="flex-1" />
              {rewindPromptIndex !== undefined && <RewindMenu targetPromptIndex={rewindPromptIndex} variant="request" />}
              {(overflowing || expanded) && (
                <button onClick={() => setExpanded((value) => !value)} className="h-7 px-1.5 text-mute hover:text-fg">
                  {expanded ? (zh ? "收起" : "Collapse") : (zh ? "显示更多" : "Show more")}
                </button>
              )}
            </div>
          )}
        </div>
        <span className="pointer-events-none absolute -bottom-4 right-0 tnum text-[10.5px] text-faint opacity-0 transition-opacity group-hover/user:opacity-100">
          {fmtClock(block.ts)}
        </span>
      </div>
    </div>
  );
}

/** Agent message — an editorial transcript with a quiet identity rail. */
export function AssistantMsg({ block, process = false }: { block: AssistantBlock; process?: boolean }) {
  if (process) {
    return (
      <div className="process-text mb-3 animate-fade-up">
        <span className="process-node" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <Markdown
            text={block.text}
            streaming={block.streaming ?? false}
            className="process-prose text-[12.5px] leading-[1.72] text-mute"
          />
          {block.streaming && <span className="stream-caret" />}
        </div>
      </div>
    );
  }

  return (
    <article className="assistant-message mb-7 animate-fade-up">
      <div className="assistant-message__content min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2.5">
          <BlackHole size={17} spin={block.streaming ?? false} />
          <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-dim">GROX</span>
          {block.streaming && <span className="text-[9.5px] text-faint">正在输出</span>}
        </div>
        <Markdown text={block.text} streaming={block.streaming ?? false} className="assistant-prose text-[14px] leading-[1.76] text-fg2" />
        {block.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
}

/** System event — a centered mono whisper (compact, rewind, errors). */
export function SystemEvent({ block }: { block: SystemBlock }) {
  const tone =
    block.kind === "error" ? "text-red" : block.kind === "compact" || block.kind === "rewind" ? "text-gold" : "text-dim";
  return (
    <div className="mb-2 flex min-h-7 items-start gap-2 rounded-[5px] border border-line bg-high/30 px-2.5 py-1.5 animate-fade-up">
      <Icon name={block.kind === "error" ? "x" : block.kind === "rewind" ? "refresh" : "bolt"} size={10} className={`mt-1 shrink-0 ${tone}`} />
      <span className={`min-w-0 font-mono text-[9.5px] leading-relaxed ${tone}`}>{block.text}</span>
    </div>
  );
}

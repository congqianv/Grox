import { useMemo, useState } from "react";
import type { DiffHunk, SessionBlock } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { DiffView } from "./DiffView";
import { RewindMenu } from "./RewindMenu";

const VISIBLE_FILES = 3;

function mergeTurnDiffs(blocks: SessionBlock[]) {
  const files = new Map<string, DiffHunk>();
  for (const block of blocks) {
    if (block.type !== "tool" || !block.call.diff) continue;
    for (const hunk of block.call.diff) {
      const current = files.get(hunk.path);
      files.set(
        hunk.path,
        current
          ? {
              path: hunk.path,
              added: current.added + hunk.added,
              removed: current.removed + hunk.removed,
              lines: [...current.lines, ...hunk.lines],
            }
          : { ...hunk, lines: [...hunk.lines] },
      );
    }
  }
  return [...files.values()];
}

/** Upstream: per-turn file-change summary + review + rewind. */
export function TurnChangeCard({
  blocks,
  promptIndex,
}: {
  blocks: SessionBlock[];
  promptIndex: number;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [showAll, setShowAll] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const openPreview = useDesktop((state) => state.openPreview);
  const diffs = useMemo(() => mergeTurnDiffs(blocks), [blocks]);

  if (diffs.length === 0 || promptIndex < 0) return null;

  const added = diffs.reduce((sum, hunk) => sum + hunk.added, 0);
  const removed = diffs.reduce((sum, hunk) => sum + hunk.removed, 0);
  const visible = showAll ? diffs : diffs.slice(0, VISIBLE_FILES);
  const hiddenCount = Math.max(0, diffs.length - VISIBLE_FILES);

  return (
    <section className="mb-2 overflow-hidden rounded-[8px] border border-line2 bg-raise/65 animate-fade-up">
      <div className="flex min-h-[70px] items-center gap-3 border-b border-line px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] border border-line2 bg-high text-mute">
          <Icon name="edit" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-fg2">
            {zh
              ? `已编辑 ${diffs.length} 个文件`
              : `Edited ${diffs.length} ${diffs.length === 1 ? "file" : "files"}`}
          </p>
          <p className="mt-0.5 font-mono text-[10px]">
            <span className="text-green">+{added}</span>
            <span className="ml-1.5 text-red">−{removed}</span>
          </p>
        </div>
        <RewindMenu targetPromptIndex={promptIndex} variant="request" />
        <button
          type="button"
          onClick={() => setReviewing((value) => !value)}
          className={`flex h-8 items-center gap-1.5 rounded-[5px] border px-3 text-[10.5px] transition-colors ${
            reviewing
              ? "border-acc-dim bg-acc-wash text-fg"
              : "border-line2 text-fg2 hover:border-line3 hover:bg-high"
          }`}
          aria-expanded={reviewing}
        >
          <Icon name={reviewing ? "chevronDown" : "search"} size={11} />
          {reviewing ? (zh ? "收起审核" : "Close review") : zh ? "审核" : "Review"}
        </button>
      </div>

      <div className="px-4 py-2">
        {visible.map((hunk) => (
          <button
            key={hunk.path}
            type="button"
            onClick={() => void openPreview(hunk.path)}
            className="group flex min-h-9 w-full items-center gap-3 rounded-[4px] px-1 text-left hover:bg-high"
            title={zh ? `预览 ${hunk.path}` : `Preview ${hunk.path}`}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute group-hover:text-fg2">
              {hunk.path}
            </span>
            <span className="shrink-0 font-mono text-[10px]">
              <span className="text-green">+{hunk.added}</span>
              <span className="ml-1.5 text-red">−{hunk.removed}</span>
            </span>
          </button>
        ))}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="mt-1 flex h-8 items-center gap-2 px-1 text-[10.5px] text-dim hover:text-fg2"
            aria-expanded={showAll}
          >
            {showAll
              ? zh
                ? "收起文件"
                : "Show fewer files"
              : zh
                ? `再显示 ${hiddenCount} 个文件`
                : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
            <Icon
              name="chevronDown"
              size={9}
              className={`transition-transform ${showAll ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {reviewing && (
        <div className="max-h-[420px] overflow-y-auto border-t border-line bg-void/45 p-3">
          <DiffView diff={diffs} />
        </div>
      )}
    </section>
  );
}

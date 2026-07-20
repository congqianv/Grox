/* ─────────────────────────────────────────────────────────────────────────
   CommandPalette — ⌘K. A single mono column: actions first, then recent
   missions. Keyboard-only navigation, the way instruments should be.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import { EFFORTS } from "../../bridge/types";
import { fmtRelTime } from "../../lib/format";
import { Icon, type IconProps } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

interface Item {
  id: string;
  icon: IconProps["name"];
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const { language, t } = useI18n();
  const open = useDesktop((s) => s.paletteOpen);
  const setOpen = useDesktop((s) => s.setPaletteOpen);
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const newProject = useDesktop((s) => s.newProject);
  const openSession = useDesktop((s) => s.openSession);
  const goHome = useDesktop((s) => s.goHome);
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);
  const compact = useDesktop((s) => s.compact);
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const setModel = useDesktop((s) => s.setModel);
  const effort = useDesktop((s) => s.effort);
  const setEffort = useDesktop((s) => s.setEffort);

  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const close = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const actions: Item[] = [
      { id: "new", icon: "plus", label: t("newProject"), hint: "⌘N", run: close(() => void newProject()) },
      { id: "home", icon: "home", label: language === "zh-CN" ? "任务控制台" : "Mission control", hint: "", run: close(goHome) },
      { id: "inspector", icon: "panelRight", label: language === "zh-CN" ? "显示/隐藏检查器" : "Toggle inspector", hint: "⌘J", run: close(toggleInspector) },
      { id: "settings", icon: "gear", label: t("settings"), hint: "⌘,", run: close(() => setSettingsOpen(true)) },
      {
        id: "model",
        icon: "bolt",
        label: `Cycle model — ${models.find((m) => m.id === model)?.label ?? model}`,
        run: close(() => {
          const i = models.findIndex((m) => m.id === model);
          setModel(models[(i + 1 + models.length) % models.length].id);
        }),
      },
      {
        id: "effort",
        icon: "layers",
        label: `Cycle effort — ${effort.toUpperCase()}`,
        run: close(() => {
          const i = EFFORTS.indexOf(effort);
          setEffort(EFFORTS[(i + 1) % EFFORTS.length]);
        }),
      },
      {
        id: "compact",
        icon: "refresh",
        label: "Compact context",
        run: close(compact),
      },
    ];
    const missions: Item[] = [...sessionIndex]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((m) => ({
        id: `s-${m.id}`,
        icon: "clock" as const,
        label: m.title,
        hint: fmtRelTime(m.updatedAt),
        run: close(() => openSession(m.id)),
      }));

    const q = query.trim().toLowerCase();
    const all = [...actions, ...missions];
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
  }, [query, sessionIndex, model, models, effort, newProject, openSession, goHome, toggleInspector, setSettingsOpen, setModel, setEffort, compact, setOpen, language, t]);

  useEffect(() => setIdx(0), [query]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[Math.min(idx, items.length - 1)]?.run();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-void/50 backdrop-blur-[3px]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="mx-auto mt-[15vh] w-[540px] overflow-hidden rounded-lg border border-line2 bg-raise shadow-[var(--shadow-float)] animate-fade-up"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Icon name="search" size={14} className="text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={language === "zh-CN" ? "输入命令或搜索任务…" : "Type a command or search…"}
            className="h-12 flex-1 bg-transparent text-[14px] text-fg placeholder:text-faint focus:outline-none"
          />
          <kbd className="rounded-md bg-high px-1.5 py-0.5 text-[11px] text-faint">Esc</kbd>
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-dim">
              {language === "zh-CN" ? "没有匹配结果。" : "No matches."}
            </p>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setIdx(i)}
              onClick={item.run}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${
                i === idx ? "bg-high" : "hover:bg-high/50"
              }`}
            >
              <Icon name={item.icon} size={14} className={i === idx ? "text-acc" : "text-dim"} />
              <span className={`flex-1 truncate text-[13px] ${i === idx ? "text-fg" : "text-fg2"}`}>
                {item.label}
              </span>
              {item.hint && <span className="tnum text-[11px] text-faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

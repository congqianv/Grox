/* Minimal popup select — chip trigger + viewport-aware floating menu. */

import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../fx/Icon";
import { FloatingMenu } from "./FloatingMenu";

export interface SelectItem {
  id: string;
  label: string;
  hint?: string;
}

export function ChipSelect({
  label,
  items,
  activeId,
  onSelect,
  width = 200,
  disabled = false,
}: {
  label: ReactNode;
  items: SelectItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  width?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        className="chip max-w-[220px] min-w-0 disabled:cursor-wait disabled:opacity-60"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 truncate leading-none">{label}</span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      <FloatingMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        prefer="up"
        estimatedHeight={Math.min(360, 40 + items.length * 34)}
        width={width}
        className="py-1"
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => {
              onSelect(it.id);
              setOpen(false);
            }}
            title={it.hint ? `${it.label} — ${it.hint}` : it.label}
            className={`grid w-full grid-cols-[6px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              it.id === activeId ? "bg-high" : "hover:bg-high/60"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${it.id === activeId ? "bg-acc" : "bg-transparent"}`}
            />
            <span className="truncate text-[12.5px] leading-none text-fg2">{it.label}</span>
            <span className="truncate text-right text-[11px] leading-none text-faint">{it.hint ?? ""}</span>
          </button>
        ))}
      </FloatingMenu>
    </div>
  );
}

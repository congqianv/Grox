/* Viewport-aware floating menu — portals to document.body so parent
   overflow / stacking never clips it. Prefers opening above the trigger
   when near the bottom of the window (composer toolbar case). */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type MenuPlacement = "up" | "down";

export interface FloatingMenuProps {
  open: boolean;
  onClose(): void;
  /** Element that anchors the menu (usually the chip/button wrapper). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Preferred direction; actual placement may flip to stay in viewport. */
  prefer?: MenuPlacement;
  /** Estimated menu height for flip decision before measure. */
  estimatedHeight?: number;
  width?: number | string;
  className?: string;
  children: ReactNode;
}

interface MenuBox {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: MenuPlacement;
}

const GAP = 6;
const EDGE = 8;

function computeBox(
  anchor: DOMRect,
  menuWidth: number,
  menuHeight: number,
  prefer: MenuPlacement,
): MenuBox {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceAbove = anchor.top - EDGE;
  const spaceBelow = vh - anchor.bottom - EDGE;

  let placement: MenuPlacement = prefer;
  if (prefer === "down" && spaceBelow < Math.min(menuHeight, 160) && spaceAbove > spaceBelow) {
    placement = "up";
  } else if (prefer === "up" && spaceAbove < Math.min(menuHeight, 160) && spaceBelow > spaceAbove) {
    placement = "down";
  }

  const maxHeight = Math.max(
    120,
    Math.min(menuHeight, placement === "up" ? spaceAbove - GAP : spaceBelow - GAP, vh - EDGE * 2),
  );

  let top =
    placement === "up"
      ? anchor.top - GAP - Math.min(menuHeight, maxHeight)
      : anchor.bottom + GAP;
  // Clamp vertically just in case.
  top = Math.min(Math.max(EDGE, top), vh - EDGE - Math.min(menuHeight, maxHeight));

  let left = anchor.left;
  const width = Math.min(menuWidth, vw - EDGE * 2);
  if (left + width > vw - EDGE) left = vw - EDGE - width;
  if (left < EDGE) left = EDGE;

  return { top, left, width, maxHeight, placement };
}

export function FloatingMenu({
  open,
  onClose,
  anchorRef,
  prefer = "up",
  estimatedHeight = 220,
  width = 280,
  className = "",
  children,
}: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<MenuBox | null>(null);

  const reposition = () => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const menuWidth = typeof width === "number" ? width : 280;
    const measured = menuRef.current?.offsetHeight ?? estimatedHeight;
    setBox(computeBox(anchor, menuWidth, measured || estimatedHeight, prefer));
  };

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    reposition();
    // Re-measure after first paint so maxHeight/flip use real menu height.
    const frame = requestAnimationFrame(() => reposition());
    return () => cancelAnimationFrame(frame);
    // Intentionally not depending on `children` — parent re-renders would thrash layout.
  }, [open, prefer, width, estimatedHeight]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onReposition = () => reposition();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  const style: CSSProperties = box
    ? {
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        maxHeight: box.maxHeight,
        zIndex: 200,
      }
    : {
        position: "fixed",
        // Off-screen until measured to avoid a one-frame flash at 0,0.
        top: -9999,
        left: -9999,
        width: typeof width === "number" ? width : width,
        zIndex: 200,
        visibility: "hidden",
      };

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      className={`overflow-y-auto overflow-x-hidden rounded-lg border border-line2 bg-raise shadow-[var(--shadow-float)] animate-fade-up ${className}`}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   TitleBar — custom chrome over macOS Overlay title bar.
   macOS: decorations:true + titleBarStyle:Overlay shows native traffic lights
   (red/yellow/green). decorations:false would hide them entirely.
   Windows: custom min / max / close on the right.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { useDesktop } from "../../state/store";
import { baseName } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

const inTauri = () => "__TAURI_INTERNALS__" in window;
const isMac = () => navigator.userAgent.includes("Mac");

async function windowCtl(action: "min" | "max" | "close") {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (action === "min") await win.minimize();
  else if (action === "max") await win.toggleMaximize();
  else await win.close();
}

export function TitleBar() {
  const { language } = useI18n();
  const activeId = useDesktop((s) => s.activeId);
  const meta = useDesktop((s) => s.sessionIndex.find((m) => m.id === s.activeId));
  const bridgeKind = useDesktop((s) => s.bridgeKind);
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const setPaletteOpen = useDesktop((s) => s.setPaletteOpen);
  const [maximized, setMaximized] = useState(false);
  // macOS uses native traffic lights from Overlay title bar — do not draw fakes.
  const showCustomWindowButtons = !isMac();

  useEffect(() => {
    if (!inTauri() || !showCustomWindowButtons) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    })();
    return () => unlisten?.();
  }, [showCustomWindowButtons]);

  return (
    <header
      data-tauri-drag-region
      className={`relative z-10 flex h-11 shrink-0 items-center overflow-visible border-b border-line bg-panel select-none ${
        isMac() ? "pl-[88px] pr-2" : "pl-3 pr-1"
      }`}
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex min-w-0 flex-1 items-center justify-center px-3"
      >
        <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden whitespace-nowrap text-[12.5px]">
          {activeId && meta ? (
            <>
              <span className="max-w-[35%] shrink-0 truncate text-dim">{baseName(meta.cwd)}</span>
              <span className="shrink-0 text-faint">/</span>
              <span className="min-w-0 truncate font-medium text-fg2">{meta.title}</span>
            </>
          ) : (
            <span className="text-[13px] font-medium tracking-tight text-mute">Grox</span>
          )}
        </div>
      </div>

      <div className="relative z-20 flex shrink-0 items-center gap-1.5">
        <span className={`chip mr-0.5 ${bridgeKind === "mock" ? "" : "!bg-acc-wash !text-fg2"}`}>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              bridgeKind === "mock" ? "bg-dim" : "bg-green animate-pulse-dot"
            }`}
          />
          {bridgeKind === "mock" ? (language === "zh-CN" ? "模拟" : "Mock") : "ACP"}
        </span>

        <button
          className="chip"
          onClick={() => setPaletteOpen(true)}
          title={language === "zh-CN" ? "命令面板" : "Command palette"}
        >
          <Icon name="command" size={12} />
          <span>{isMac() ? "⌘K" : "Ctrl+K"}</span>
        </button>

        <button
          className={`chip ${inspectorOpen ? "!bg-high !text-fg" : ""}`}
          onClick={toggleInspector}
          title={language === "zh-CN" ? "显示/隐藏检查器" : "Toggle inspector"}
        >
          <Icon name="panelRight" size={12} />
        </button>

        {showCustomWindowButtons && (
          <div className="ml-1 flex items-center border-l border-line pl-1">
            <WinBtn
              onClick={() => void windowCtl("min")}
              title={language === "zh-CN" ? "最小化" : "Minimize"}
              label="—"
            />
            <WinBtn
              onClick={() => void windowCtl("max")}
              title={
                language === "zh-CN"
                  ? maximized
                    ? "还原"
                    : "最大化"
                  : maximized
                    ? "Restore"
                    : "Maximize"
              }
              label={maximized ? "❐" : "▢"}
            />
            <WinBtn
              onClick={() => void windowCtl("close")}
              title={language === "zh-CN" ? "关闭" : "Close"}
              label="✕"
              danger
            />
          </div>
        )}
      </div>
    </header>
  );
}

function WinBtn({
  onClick,
  label,
  title,
  danger,
}: {
  onClick: () => void;
  label: string;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-8 w-11 items-center justify-center text-[11px] text-mute transition-colors ${
        danger ? "hover:bg-red hover:text-base" : "hover:bg-high hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

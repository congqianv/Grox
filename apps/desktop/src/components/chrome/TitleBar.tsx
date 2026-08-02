/* ─────────────────────────────────────────────────────────────────────────
   TitleBar — custom chrome over macOS Overlay title bar.
   macOS: decorations:true + titleBarStyle:Overlay shows native traffic lights
   (red/yellow/green). decorations:false would hide them entirely.
   Windows: custom min / max / close on the right.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useDesktop } from "../../state/store";
import { baseName } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";
import { EnvironmentSummary } from "./EnvironmentSummary";
import {
  getAvailableOpenApplications,
  getDefaultOpenApplication,
  refreshOpenApplications,
  setDefaultOpenApplication,
  type OpenApplicationOption,
} from "../../lib/defaultOpen";

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
  const zh = language === "zh-CN";
  const activeId = useDesktop((s) => s.activeId);
  const meta = useDesktop((s) => s.sessionIndex.find((m) => m.id === s.activeId));
  const bridgeKind = useDesktop((s) => s.bridgeKind);
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const toggleTerminal = useDesktop((s) => s.toggleTerminal);
  const terminalOpen = useDesktop((s) => s.terminalOpen);
  const setPaletteOpen = useDesktop((s) => s.setPaletteOpen);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);
  const appUpdate = useDesktop((s) => s.appUpdate);
  const dismissed = useDesktop((s) => s.appUpdateDismissedVersion);
  const installAppUpdate = useDesktop((s) => s.installAppUpdate);
  const appUpdateInstalling = useDesktop((s) => s.appUpdateInstalling);
  const appUpdateProgress = useDesktop((s) => s.appUpdateProgress);
  const dismissAppUpdate = useDesktop((s) => s.dismissAppUpdate);
  const showUpdate =
    Boolean(appUpdate?.updateAvailable)
    && appUpdate?.latestVersion
    && appUpdate.latestVersion !== dismissed;
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
        {showUpdate && appUpdate && (
          <div className="mr-0.5 flex items-center gap-1 rounded-md border border-acc-dim/50 bg-acc-wash px-1.5 py-0.5">
            <button
              type="button"
              disabled={appUpdateInstalling}
              className="flex items-center gap-1 text-[11px] font-medium text-acc hover:text-fg disabled:opacity-60"
              onClick={() => void installAppUpdate()}
              title={
                appUpdateInstalling
                  ? (appUpdateProgress?.message || (zh ? "正在更新…" : "Updating…"))
                  : (zh ? `立即更新到 v${appUpdate.latestVersion}` : `Update to v${appUpdate.latestVersion}`)
              }
            >
              <Icon name="bolt" size={11} className={appUpdateInstalling ? "animate-orbit" : ""} />
              <span>
                {appUpdateInstalling
                  ? (appUpdateProgress?.stage === "downloading" && appUpdateProgress.percent > 0
                    ? (zh ? `下载中 ${appUpdateProgress.percent}%` : `Downloading ${appUpdateProgress.percent}%`)
                    : (zh ? "正在更新…" : "Updating…"))
                  : (zh ? `更新 v${appUpdate.latestVersion}` : `Update v${appUpdate.latestVersion}`)}
              </span>
            </button>
            {!appUpdateInstalling && (
              <>
                <button
                  type="button"
                  className="px-0.5 text-[10px] text-dim hover:text-fg"
                  onClick={() => setSettingsOpen(true)}
                  title={zh ? "打开设置" : "Open settings"}
                >
                  ·
                </button>
                <button
                  type="button"
                  className="px-0.5 text-[11px] text-faint hover:text-fg"
                  onClick={() => dismissAppUpdate()}
                  title={zh ? "稍后提醒" : "Dismiss"}
                >
                  ×
                </button>
              </>
            )}
          </div>
        )}

        <span className={`chip mr-0.5 ${bridgeKind === "mock" ? "" : "!bg-acc-wash !text-fg2"}`}>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              bridgeKind === "mock" ? "bg-dim" : "bg-green animate-pulse-dot"
            }`}
          />
          {bridgeKind === "mock" ? (zh ? "模拟" : "Mock") : "ACP"}
        </span>

        <DefaultOpenMenu language={language === "zh-CN" ? "zh-CN" : "en-US"} />

        <button
          className="chip"
          onClick={() => setPaletteOpen(true)}
          title={zh ? "命令面板" : "Command palette"}
        >
          <Icon name="command" size={12} />
          <span>{isMac() ? "⌘K" : "Ctrl+K"}</span>
        </button>

        <EnvironmentSummary />

        {activeId && (
          <button
            className={`chip ${terminalOpen ? "!bg-high !text-fg" : ""}`}
            onClick={toggleTerminal}
            title={zh ? "终端输出" : "Terminal panel"}
            aria-pressed={terminalOpen}
          >
            <Icon name="terminal" size={12} />
          </button>
        )}

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

function DefaultOpenMenu({ language }: { language: "zh-CN" | "en-US" }) {
  const [open, setOpen] = useState(false);
  const [applications, setApplications] = useState<OpenApplicationOption[]>(() =>
    getAvailableOpenApplications(),
  );
  const [application, setApplication] = useState<OpenApplicationOption>(() =>
    getDefaultOpenApplication(),
  );
  const ref = useRef<HTMLDivElement>(null);
  const zh = language === "zh-CN";

  useEffect(() => {
    const syncApplications = (event: Event) => {
      const value = (event as CustomEvent<OpenApplicationOption[]>).detail;
      if (Array.isArray(value)) setApplications(value);
    };
    const sync = (event: Event) => {
      const value = (event as CustomEvent<OpenApplicationOption>).detail;
      if (value?.id) setApplication(value);
    };
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("grox:open-applications", syncApplications);
    window.addEventListener("grox:default-open-application", sync);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    // Do not scan installed apps on mount — that spawns powershell.exe on
    // Windows and was flashing a blue console at cold start. Discovery runs
    // only when the operator opens this menu.
    return () => {
      window.removeEventListener("grox:open-applications", syncApplications);
      window.removeEventListener("grox:default-open-application", sync);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const label = (value: OpenApplicationOption) =>
    value.isDefault ? (zh ? "系统默认" : "System default") : value.name;
  const fallbackIcon = (
    value: OpenApplicationOption,
  ): ComponentProps<typeof Icon>["name"] => {
    const name = value.name.toLowerCase();
    if (name.includes("finder")) return "folder";
    if (name.includes("terminal") || name.includes("ghostty") || name.includes("shell"))
      return "terminal";
    return "external";
  };

  const current = applications.find((item) => item.id === application.id) ?? application;
  const appIcon = (value: OpenApplicationOption, size: number) =>
    value.iconDataUrl ? (
      <img
        src={value.iconDataUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[3px] object-contain"
      />
    ) : (
      <Icon name={fallbackIcon(value)} size={size} className="shrink-0" />
    );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`chip gap-1 ${open ? "!border-line3 !text-fg2" : ""}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) {
            void refreshOpenApplications().then((items) => {
              setApplications(items);
              setApplication(getDefaultOpenApplication());
            });
          }
        }}
        title={zh ? "选择文件的默认打开方式" : "Choose the default application for files"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {appIcon(current, 13)}
        <span>{zh ? "打开方式" : "OPEN WITH"}</span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-9 z-[60] w-52 overflow-hidden rounded-[7px] border border-line3 bg-raise p-1.5 shadow-2xl"
          role="menu"
        >
          <p className="px-2 pb-1.5 pt-1 font-mono text-[8.5px] tracking-[0.12em] text-faint">
            {zh ? "文件默认打开应用" : "DEFAULT FILE APPLICATION"}
          </p>
          {applications.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={application.id === item.id}
              onClick={() => {
                setDefaultOpenApplication(item);
                setApplication(item);
                setOpen(false);
              }}
              className={`flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[10.5px] transition-colors ${
                application.id === item.id
                  ? "bg-acc-wash text-fg"
                  : "text-mute hover:bg-high hover:text-fg2"
              }`}
            >
              <span className={application.id === item.id ? "text-acc" : "text-dim"}>
                {appIcon(item, 15)}
              </span>
              <span className="flex-1">{label(item)}</span>
              {application.id === item.id && <Icon name="check" size={10} className="text-acc" />}
            </button>
          ))}
        </div>
      )}
    </div>
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

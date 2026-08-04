/* App shell — window chrome, three-column deck, overlays, keymap. */

import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { useDesktop } from "./state/store";
import { TitleBar } from "./components/chrome/TitleBar";
import { Sidebar } from "./components/chrome/Sidebar";
import { StatusBar } from "./components/chrome/StatusBar";
import { Home } from "./components/home/Home";
import { Timeline } from "./components/session/Timeline";
import { Composer } from "./components/session/Composer";
import { SubagentRail } from "./components/session/SubagentRail";
import { Inspector } from "./components/inspector/Inspector";
import { CommandPalette } from "./components/palette/CommandPalette";
import { SettingsModal } from "./components/settings/SettingsModal";
import { BlackHole } from "./components/fx/BlackHole";
import { PreviewPane } from "./components/preview/PreviewPane";
import { PlanPreviewPane } from "./components/preview/PlanPreviewPane";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { ResizeHandle } from "./components/common/ResizeHandle";
import { usePreferences } from "./state/preferences";
import { useI18n } from "./lib/i18n";
import { AccountSetup } from "./components/settings/AccountSetup";

class SessionErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void; language: string },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Session view crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const zh = this.props.language === "zh-CN";
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-[14px] font-medium text-fg">{zh ? "打开会话时出错" : "Failed to open session"}</p>
          <p className="max-w-md text-[12.5px] text-mute">{this.state.error}</p>
          <button
            className="mt-2 rounded-md border border-line2 bg-raise px-3 py-1.5 text-[12.5px] text-fg2 hover:bg-high"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset();
            }}
          >
            {zh ? "返回首页" : "Back to home"}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { language } = useI18n();
  const ready = useDesktop((s) => s.ready);
  const view = useDesktop((s) => s.view);
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const startupError = useDesktop((s) => s.startupError);
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const previewOpen = useDesktop((s) => s.previewOpen);
  const planPreviewOpen = useDesktop((s) => s.planPreviewOpen);
  const terminalOpen = useDesktop((s) => s.terminalOpen);
  const goHome = useDesktop((s) => s.goHome);
  const sidebarWidth = usePreferences((s) => s.sidebarWidth);
  const setSidebarWidth = usePreferences((s) => s.setSidebarWidth);

  useEffect(() => {
    void useDesktop.getState().init();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useDesktop.getState();
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void s.newProject();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        s.setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.toggleInspector();
      } else if (mod && e.key === "`") {
        e.preventDefault();
        s.toggleTerminal();
      } else if (e.key === "Escape") {
        if (s.paletteOpen) s.setPaletteOpen(false);
        else if (s.settingsOpen) s.setSettingsOpen(false);
        else if (s.terminalOpen) s.toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-base">
        <BlackHole size={38} spin />
        <span className="text-[13px] text-mute">{language === "zh-CN" ? "正在连接 Grok…" : "Connecting to Grok…"}</span>
      </div>
    );
  }

  const inSession = view === "session" && activeId;

  return (
    <div className="flex h-screen flex-col bg-base">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ResizeHandle side="right" value={sidebarWidth} onChange={setSidebarWidth} />
        {/* z-10: composer popovers open below the toolbar and must stack above StatusBar */}
        <main className="relative z-10 flex min-w-0 flex-1 flex-col bg-base">
          {startupError && !inSession && (
            <div className="border-b border-red/20 bg-red/5 px-4 py-2 text-[12.5px] text-red">
              {startupError}
            </div>
          )}
          <SessionErrorBoundary language={language} onReset={goHome}>
            {inSession && session ? (
              <>
                <Timeline session={session} />
                {terminalOpen && <TerminalPanel />}
                <Composer />
              </>
            ) : inSession && !session ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <BlackHole size={28} spin />
                <span className="text-[13px] text-mute">{language === "zh-CN" ? "正在恢复任务…" : "Restoring session…"}</span>
                {startupError && <p className="max-w-md px-6 text-center text-[12px] text-red">{startupError}</p>}
              </div>
            ) : (
              <Home />
            )}
          </SessionErrorBoundary>
        </main>
        {inSession && session && (
          <SubagentRail session={session} zh={language === "zh-CN"} />
        )}
        {inspectorOpen && !planPreviewOpen && inSession && session && <Inspector />}
        {previewOpen && <PreviewPane />}
        {planPreviewOpen && inSession && session && <PlanPreviewPane />}
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsModal />
      <AccountSetup />
    </div>
  );
}

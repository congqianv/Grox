import { useEffect, useMemo, useRef } from "react";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";

/** Upstream: bottom panel aggregating tool terminal IO for the active session. */
export function TerminalPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const session = useDesktop((state) =>
    state.activeId ? state.sessions[state.activeId] : null,
  );
  const toggleTerminal = useDesktop((state) => state.toggleTerminal);
  const scrollRef = useRef<HTMLDivElement>(null);
  const calls = useMemo(
    () =>
      (session?.blocks ?? []).flatMap((block) =>
        block.type === "tool" && block.call.terminal ? [block.call] : [],
      ),
    [session],
  );
  const lineCount = calls.reduce(
    (count, call) => count + (call.terminal?.lines.length ?? 0),
    0,
  );

  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [calls, lineCount]);

  return (
    <section
      className="flex h-[min(280px,42vh)] shrink-0 flex-col overflow-hidden border-t border-line2 bg-void animate-fade-up"
      aria-label={zh ? "终端" : "Terminal"}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Icon name="terminal" size={12} className="text-acc" />
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg2">
          {zh ? "终端" : "TERMINAL"}
        </span>
        {calls.length > 0 && (
          <span className="font-mono text-[9px] text-faint">
            {calls.length} {zh ? "条命令" : calls.length === 1 ? "COMMAND" : "COMMANDS"}
          </span>
        )}
        <button
          type="button"
          onClick={toggleTerminal}
          className="ml-auto flex h-6 w-6 items-center justify-center text-dim transition-colors hover:bg-high hover:text-fg"
          title={zh ? "关闭终端" : "Close terminal"}
          aria-label={zh ? "关闭终端" : "Close terminal"}
        >
          <Icon name="x" size={10} />
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px]">
        {calls.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-faint">
            {zh
              ? "本会话尚无终端命令输出。Agent 执行 shell 工具后会出现在这里。"
              : "No terminal output in this session yet. Shell tool runs will appear here."}
          </p>
        ) : (
          calls.map((call) => (
            <div key={call.id} className="mb-4 last:mb-0">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-dim">
                <span className="text-acc">$</span>
                <span className="min-w-0 flex-1 truncate text-fg2">
                  {call.terminal?.cmd || call.title}
                </span>
                {call.terminal?.exitCode !== undefined && (
                  <span
                    className={
                      call.terminal.exitCode === 0 ? "text-green" : "text-red"
                    }
                  >
                    exit {call.terminal.exitCode}
                  </span>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-mute">
                {(call.terminal?.lines ?? []).join("\n") || " "}
              </pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

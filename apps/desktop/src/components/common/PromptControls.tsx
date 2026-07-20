import { useEffect, useRef, useState } from "react";
import { EFFORTS, type AgentMode, type Effort, type PermissionMode } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "./ChipSelect";

export function ProviderSwitcher() {
  const { language } = useI18n();
  const provider = useDesktop((state) => state.provider);
  const profiles = useDesktop((state) => state.providerProfiles);
  const activeProfileId = useDesktop((state) => state.activeProviderProfileId);
  const switching = useDesktop((state) => state.providerSwitching);
  const configure = useDesktop((state) => state.configureProvider);
  const activate = useDesktop((state) => state.activateProviderProfile);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const activeId = activeProfileId ?? provider.kind;
  const label = switching
    ? (language === "zh-CN" ? "切换中" : "Switching")
    : activeProfile?.name ?? (provider.kind === "oauth" ? "Grok OAuth" : provider.kind === "official" ? "xAI API" : "OpenAI API");
  const items = [
    { id: "oauth", label: "Grok OAuth", hint: language === "zh-CN" ? "官方账户" : "Official account" },
    ...(provider.kind === "official" && !activeProfileId
      ? [{ id: "official", label: "xAI API", hint: language === "zh-CN" ? "当前官方密钥" : "Current official key" }]
      : []),
    ...profiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      hint: profile.baseUrl.replace(/^https?:\/\//, ""),
    })),
  ];

  return (
    <ChipSelect
      label={<span className="text-fg2">{label}</span>}
      items={items}
      activeId={activeId}
      disabled={switching}
      width={330}
      onSelect={(id) => {
        if (id === activeId || id === "official") return;
        if (id === "oauth") void configure({ kind: "oauth" }).catch(() => {});
        else void activate(id).catch(() => {});
      }}
    />
  );
}

export function PromptOptionsMenu({
  mode,
  effort,
  permissionMode,
  onMode,
  onEffort,
  onPermission,
}: {
  mode: AgentMode;
  effort: Effort;
  permissionMode: PermissionMode;
  onMode(mode: AgentMode): void;
  onEffort(effort: Effort): void;
  onPermission(mode: PermissionMode): void;
}) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((value) => !value)} className="chip max-w-[190px]" title={language === "zh-CN" ? "模式、权限与思考强度" : "Mode, access and reasoning effort"}>
        <Icon name="gear" size={11} />
        <span className="truncate capitalize">{mode} · {effort}</span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      {open && (
        // Open downward so the panel never covers the textarea above the toolbar.
        <div className="absolute left-0 top-full z-50 mt-1.5 w-[min(360px,calc(100vw-32px))] rounded-lg border border-line2 bg-raise p-3 shadow-[var(--shadow-float)] animate-fade-up">
          <OptionRow label={language === "zh-CN" ? "工作模式" : "Mode"} values={[
            ["agent", language === "zh-CN" ? "执行" : "Agent"],
            ["plan", language === "zh-CN" ? "计划" : "Plan"],
            ["ask", language === "zh-CN" ? "问答" : "Ask"],
          ]} active={mode} onSelect={(value) => onMode(value as AgentMode)} />
          <OptionRow label={language === "zh-CN" ? "工具权限" : "Access"} values={[
            ["default", language === "zh-CN" ? "按需确认" : "Default"],
            ["auto", language === "zh-CN" ? "自动策略" : "Auto"],
            ["bypass", "YOLO"],
          ]} active={permissionMode} onSelect={(value) => onPermission(value as PermissionMode)} />
          <OptionRow label={language === "zh-CN" ? "思考强度" : "Effort"} values={EFFORTS.map((value) => [value, value])} active={effort} onSelect={(value) => onEffort(value as Effort)} last />
        </div>
      )}
    </div>
  );
}

function OptionRow({ label, values, active, onSelect, last = false }: { label: string; values: readonly (readonly [string, string])[]; active: string; onSelect(value: string): void; last?: boolean }) {
  return (
    <div className={last ? "" : "mb-3 border-b border-line pb-3"}>
      <p className="mb-1.5 text-[11.5px] font-medium text-mute">{label}</p>
      <div className="grid grid-cols-4 gap-1">
        {values.map(([value, text]) => (
          <button key={value} onClick={() => onSelect(value)} className={`flex h-7 min-w-0 items-center justify-center truncate rounded-md border px-2 text-[11.5px] leading-none transition-colors ${active === value ? "border-transparent bg-acc text-base" : "border-line2 text-dim hover:bg-high hover:text-fg2"}`} title={text}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

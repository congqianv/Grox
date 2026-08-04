import { useRef, useState } from "react";
import { EFFORTS, type AgentMode, type Effort, type PermissionMode } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { reviewPresetLabel, reviewPreset as buildReviewPreset } from "../../lib/reviewPreset";
import type { SandboxPreference } from "../../lib/sandboxPolicy";
import { useIsFeatureEnabled } from "../../lib/useFeatureFlags";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "./ChipSelect";
import { FloatingMenu } from "./FloatingMenu";

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
  const zh = language === "zh-CN";
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const sandboxPreference = useDesktop((s) => s.sandboxPreference);
  const sandboxPendingApply = useDesktop((s) => s.sandboxPendingApply);
  const setSandboxPreference = useDesktop((s) => s.setSandboxPreference);
  const applyReviewPreset = useDesktop((s) => s.applyReviewPreset);
  const forceReconnectAgent = useDesktop((s) => s.forceReconnectAgent);
  const showSandbox = useIsFeatureEnabled("sandboxUi");
  const showReview = useIsFeatureEnabled("reviewMode");

  const sandboxLabel =
    sandboxPreference === "follow_cli"
      ? zh
        ? "跟随CLI"
        : "CLI"
      : sandboxPreference === "read_only"
        ? zh
          ? "只读"
          : "RO"
        : sandboxPreference === "off"
          ? "off"
          : "ws";

  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="chip max-w-[220px]"
        title={zh ? "模式、权限、沙箱与思考强度" : "Mode, access, sandbox and reasoning effort"}
      >
        <Icon name="gear" size={11} />
        <span className="truncate capitalize">
          {mode} · {effort} ·{" "}
          {permissionMode === "bypass"
            ? "YOLO"
            : permissionMode === "auto"
              ? zh
                ? "自动"
                : "Auto"
              : zh
                ? "确认"
                : "Ask"}
          {showSandbox ? ` · ${sandboxLabel}` : ""}
          {sandboxPendingApply ? "*" : ""}
        </span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      <FloatingMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        prefer="up"
        estimatedHeight={showSandbox || showReview ? 340 : 220}
        width={360}
        className="p-3"
      >
        <OptionRow
          label={zh ? "工作模式" : "Mode"}
          values={[
            ["agent", zh ? "执行" : "Agent"],
            ["plan", zh ? "计划" : "Plan"],
            ["ask", zh ? "问答" : "Ask"],
          ]}
          active={mode}
          onSelect={(value) => onMode(value as AgentMode)}
        />
        <OptionRow
          label={zh ? "工具权限" : "Access"}
          values={[
            ["default", zh ? "按需确认" : "Default"],
            ["auto", zh ? "自动策略" : "Auto"],
            ["bypass", "YOLO"],
          ]}
          active={permissionMode}
          onSelect={(value) => onPermission(value as PermissionMode)}
        />
        {showSandbox && (
          <OptionRow
            label={zh ? "沙箱（默认跟随 CLI）" : "Sandbox (follow CLI by default)"}
            values={[
              ["follow_cli", zh ? "跟随CLI" : "Follow CLI"],
              ["workspace", zh ? "工作区" : "Workspace"],
              ["read_only", zh ? "只读" : "Read-only"],
              ["off", "Off"],
            ]}
            active={sandboxPreference}
            onSelect={(value) => setSandboxPreference(value as SandboxPreference)}
          />
        )}
        {showSandbox && sandboxPendingApply && (
          <div className="mb-2 space-y-1.5">
            <p className="text-[10.5px] text-gold">
              {zh
                ? "新沙箱已保存，尚未注入当前 Agent（避免半生效）。空闲时可点下方重连应用。"
                : "Sandbox saved but not injected into the live agent (no half-apply). Reconnect when idle to apply."}
            </p>
            <button
              type="button"
              className="h-7 w-full rounded-[3px] border border-gold/35 bg-gold/10 px-2 font-mono text-[9.5px] text-gold hover:bg-gold/15"
              onClick={() => {
                void forceReconnectAgent().catch(() => {});
                setOpen(false);
              }}
            >
              {zh ? "重连 Agent 以应用沙箱" : "Reconnect agent to apply sandbox"}
            </button>
          </div>
        )}
        {showSandbox && sandboxPreference === "off" && (
          <p className="mb-2 text-[10.5px] text-gold">
            {zh
              ? "沙箱关闭有风险，允许继续（不会二次拦截）"
              : "Sandbox off is risky but allowed (no second gate)"}
          </p>
        )}
        {showReview && (
          <div className="mb-3 border-b border-line pb-3">
            <p className="mb-1.5 text-[11.5px] font-medium text-mute">
              {zh ? "Review 预设（可选）" : "Review preset (optional)"}
            </p>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="h-7 rounded-[3px] border border-line2 px-2 font-mono text-[9.5px] text-dim hover:border-acc-dim hover:text-acc"
                onClick={() => {
                  applyReviewPreset(false);
                  setOpen(false);
                }}
              >
                {reviewPresetLabel(buildReviewPreset(false), zh)}
              </button>
              <button
                type="button"
                className="h-7 rounded-[3px] border border-line2 px-2 font-mono text-[9.5px] text-dim hover:border-acc-dim hover:text-acc"
                onClick={() => {
                  applyReviewPreset(true);
                  setOpen(false);
                }}
              >
                {reviewPresetLabel(buildReviewPreset(true), zh)}
              </button>
            </div>
          </div>
        )}
        <OptionRow
          label={zh ? "思考强度" : "Effort"}
          values={EFFORTS.map((value) => [value, value])}
          active={effort}
          onSelect={(value) => onEffort(value as Effort)}
          last
        />
      </FloatingMenu>
    </div>
  );
}

function OptionRow({
  label,
  values,
  active,
  onSelect,
  last = false,
}: {
  label: string;
  values: readonly (readonly [string, string])[];
  active: string;
  onSelect(value: string): void;
  last?: boolean;
}) {
  return (
    <div className={last ? "" : "mb-3 border-b border-line pb-3"}>
      <p className="mb-1.5 text-[11.5px] font-medium text-mute">{label}</p>
      <div className="grid grid-cols-4 gap-1">
        {values.map(([value, text]) => (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={`flex h-7 min-w-0 items-center justify-center truncate rounded-md border px-2 text-[11.5px] leading-none transition-colors ${
              active === value
                ? "border-transparent bg-acc text-base"
                : "border-line2 text-dim hover:bg-high hover:text-fg2"
            }`}
            title={text}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

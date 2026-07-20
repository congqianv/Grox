import { useState } from "react";
import type { ProviderApiBackend, ProviderKind } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";

export function AccountSetup() {
  const { t, language } = useI18n();
  const open = useDesktop((state) => state.accountSetupOpen);
  const configure = useDesktop((state) => state.configureProvider);
  const saveProviderProfile = useDesktop((state) => state.saveProviderProfile);
  const activateProviderProfile = useDesktop((state) => state.activateProviderProfile);
  const setOpen = useDesktop((state) => state.setAccountSetupOpen);
  const runtime = useDesktop((state) => state.runtime);
  const runtimeBusy = useDesktop((state) => state.runtimeBusy);
  const useBundledRuntime = useDesktop((state) => state.useBundledRuntime);
  const installOfficialRuntime = useDesktop((state) => state.installOfficialRuntime);
  const [kind, setKind] = useState<ProviderKind>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiBackend, setApiBackend] = useState<ProviderApiBackend>("responses");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  if (runtime?.selectionRequired) {
    const chooseRuntime = async (choice: "install" | "bundled") => {
      setError(null);
      try {
        if (choice === "install") await installOfficialRuntime();
        else await useBundledRuntime();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/55 p-5 backdrop-blur-[4px]">
        <div className="w-full max-w-[620px] rounded-lg border border-line2 bg-panel p-6 shadow-[var(--shadow-float)] animate-fade-up">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-high"><BlackHole size={22} /></div>
            <div className="min-w-0 flex-1">
              <h1 className="text-[17px] font-medium tracking-tight text-fg">{language === "zh-CN" ? "选择官方 Grok Build 运行方式" : "Choose the official Grok Build runtime"}</h1>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">{language === "zh-CN" ? "两种方式都运行官方 Grok Build CLI，并通过官方 agent stdio / ACP 接入；Grox 不实现另一套 Agent harness。" : "Both options run the official Grok Build CLI over its agent stdio / ACP interface. Grox does not replace the Agent harness."}</p>
            </div>
            <button onClick={() => setOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-dim hover:bg-high hover:text-fg" title="Close"><Icon name="x" size={14} /></button>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <RuntimeOption
              icon="globe"
              title={language === "zh-CN" ? "安装官方 CLI" : "Install official CLI"}
              badge={language === "zh-CN" ? "推荐" : "Recommended"}
              description={language === "zh-CN" ? "调用 x.ai 官方安装脚本，自动安装到系统标准位置；之后终端和 Grox 共用同一个 CLI、配置和历史。" : "Run x.ai's official installer. Grox and your terminal will share the same CLI, configuration, and history."}
              disabled={runtimeBusy}
              onClick={() => void chooseRuntime("install")}
            />
            <RuntimeOption
              icon="bolt"
              title={language === "zh-CN" ? "使用内置官方 CLI" : "Use bundled official CLI"}
              badge={language === "zh-CN" ? "无需安装" : "No install"}
              description={language === "zh-CN" ? "使用随 Grox 发布、由同一 grok-build 官方源码构建的固定版本；仍保留完整工具、harness 与 ACP 能力。" : "Use the pinned official grok-build binary shipped with Grox, including its complete tools, harness, and ACP support."}
              disabled={runtimeBusy}
              onClick={() => void chooseRuntime("bundled")}
            />
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-md border border-line bg-raise px-3 py-2.5 text-[12px] text-dim">
            <span className={`h-1.5 w-1.5 rounded-full ${runtimeBusy ? "animate-pulse-dot bg-gold" : "bg-green"}`} />
            {runtimeBusy ? (language === "zh-CN" ? "正在执行官方安装并重新检测…" : "Running the official installer and detecting the CLI…") : (runtime.bundledPath ?? runtime.path)}
          </div>
          {error && <p className="mt-3 rounded-md border border-red/25 bg-red/5 px-3 py-2 text-[12px] text-red">{error}</p>}
        </div>
      </div>
    );
  }

  const submit = async () => {
    const wasComplete = localStorage.getItem("grox.accountSetupComplete") === "1";
    setBusy(true);
    setError(null);
    try {
      if (kind === "compatible") {
        const profile = await saveProviderProfile({
          name: providerName,
          apiKey,
          baseUrl,
          apiBackend,
          residentModels: [],
        });
        localStorage.setItem("grox.accountSetupComplete", "1");
        await activateProviderProfile(profile.id);
      } else {
        await configure({ kind, apiKey, baseUrl });
      }
    } catch (cause) {
      if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/55 p-5 backdrop-blur-[4px]">
      <div className="w-full max-w-[560px] rounded-lg border border-line2 bg-panel p-6 shadow-[var(--shadow-float)] animate-fade-up">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-high">
            <BlackHole size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-medium tracking-tight text-fg">{t("firstRunTitle")}</h1>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">{t("firstRunBody")}</p>
          </div>
          <button onClick={() => setOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-dim hover:bg-high hover:text-fg" title="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2">
          {(["oauth", "official", "compatible"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setKind(option)}
              className={`rounded-md border px-3 py-3 text-left transition-colors ${kind === option ? "border-transparent bg-acc text-base" : "border-line2 bg-raise hover:bg-high"}`}
            >
              <Icon name={option === "oauth" ? "user" : option === "official" ? "bolt" : "globe"} size={14} className={kind === option ? "text-base" : "text-dim"} />
              <p className={`mt-2 text-[12.5px] font-medium ${kind === option ? "text-base" : "text-fg2"}`}>
                {option === "oauth" ? t("oauth") : option === "official" ? t("officialApi") : t("compatibleApi")}
              </p>
            </button>
          ))}
        </div>

        {kind !== "oauth" && (
          <div className="mt-4 space-y-3">
            <Field label={t("apiKey")} value={apiKey} onChange={setApiKey} type="password" placeholder="xai-…" />
            {kind === "compatible" && (
              <>
                <Field label={language === "zh-CN" ? "供应商名称" : "Provider name"} value={providerName} onChange={setProviderName} placeholder={language === "zh-CN" ? "例如：公司中转 / OpenRouter" : "e.g. Company gateway / OpenRouter"} />
                <Field label={t("baseUrl")} value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" />
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-mute">{language === "zh-CN" ? "接口协议" : "API protocol"}</span>
                  <select value={apiBackend} onChange={(event) => setApiBackend(event.target.value as ProviderApiBackend)} className="h-9 w-full rounded-md border border-line2 bg-raise px-3 text-[12.5px] text-fg2 outline-none focus:border-line3">
                    <option value="responses">Responses · {language === "zh-CN" ? "完整搜索/思考事件" : "full search/reasoning events"}</option>
                    <option value="chat_completions">Chat Completions · {language === "zh-CN" ? "兼容回退" : "compatibility fallback"}</option>
                    <option value="auto">AUTO · grok2api / CLIProxyAPI / NewAPI</option>
                  </select>
                </label>
                <p className="rounded-md border border-line bg-raise px-3 py-2.5 text-[12px] leading-relaxed text-dim">{language === "zh-CN" ? "保存后会自动从 Base URL /models 获取可用模型；之后可在账户设置中选择常驻模型或添加自定义模型。" : "Grox will fetch Base URL /models automatically. Resident and custom models can be managed later in Account settings."}</p>
              </>
            )}
          </div>
        )}

        {kind === "oauth" && (
          <div className="mt-4 rounded-md border border-line bg-raise px-3 py-2.5 text-[12.5px] leading-relaxed text-dim">
            {t("oauth")} 会打开 Grok 官方登录页。登录后可读取订阅等级与上游实际提供的周额度；当前 Grok Build 接口没有独立五小时额度字段。
          </div>
        )}

        {error && <p className="mt-3 rounded-md border border-red/25 bg-red/5 px-3 py-2 text-[12px] text-red">{error}</p>}

        <button
          disabled={busy}
          onClick={() => void submit()}
          className="mt-5 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-acc text-[13px] font-medium leading-none text-base transition-colors hover:bg-acc-deep disabled:opacity-50"
        >
          {busy && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-base" />}
          {t("continue")}
        </button>
      </div>
    </div>
  );
}

function RuntimeOption({ icon, title, badge, description, disabled, onClick }: { icon: "globe" | "bolt"; title: string; badge: string; description: string; disabled: boolean; onClick(): void }) {
  return (
    <button disabled={disabled} onClick={onClick} className="group min-h-[154px] rounded-md border border-line2 bg-raise p-4 text-left transition-colors hover:border-line3 hover:bg-high disabled:cursor-wait disabled:opacity-50">
      <div className="flex items-start justify-between">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-high text-acc"><Icon name={icon} size={14} /></span>
        <span className="rounded-md bg-high px-2 py-0.5 text-[11px] leading-none text-faint group-hover:text-mute">{badge}</span>
      </div>
      <p className="mt-4 text-[13px] font-medium text-fg">{title}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-dim">{description}</p>
    </button>
  );
}
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange(value: string): void; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-mute">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="mt-1.5 h-9 w-full rounded-md border border-line2 bg-raise px-3 text-[13px] text-fg outline-none placeholder:text-faint focus:border-line3"
      />
    </label>
  );
}

import { useAiStore } from "../../stores/aiStore";
import { Shield, ShieldOff } from "lucide-react";
import { useT } from "../../lib/i18n";

export function PrivacyToggle() {
  const { config, saveConfig } = useAiStore();
  const t = useT();

  if (!config) return null;

  // "全本地模式" = full_local_mode flag in AiConfig.
  // The router will refuse all non-local LLM providers, web search will be
  // blocked, web_fetch will reject non-loopback hosts, and Claude Code will
  // be hidden.
  const isLocalMode = !!config.full_local_mode;

  const toggle = async () => {
    const newConfig = {
      ...config,
      full_local_mode: !isLocalMode,
      // Also force task routing to "local" so we don't keep cloud routes
      // dangling — the router would refuse them anyway, but this keeps the
      // settings UI honest.
      llm: {
        ...config.llm,
        task_routing: !isLocalMode
          ? Object.fromEntries(Object.keys(config.llm.task_routing).map((k) => [k, "local"]))
          : Object.fromEntries(Object.keys(config.llm.task_routing).map((k) => [k, getDefaultRoute(k)])),
      },
    };
    await saveConfig(newConfig);
  };

  return (
    <div
      className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
        isLocalMode
          ? "border-purple-500/50 bg-purple-500/10"
          : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
      }`}
      onClick={toggle}
    >
      {isLocalMode ? (
        <Shield className="w-5 h-5 text-purple-400 shrink-0" />
      ) : (
        <ShieldOff className="w-5 h-5 text-[var(--moba-text-muted)] shrink-0" />
      )}
      <div className="flex-1">
        <div className="text-[13px] font-semibold">
          {t("aiSettings.fullLocal")} {isLocalMode ? t("aiSettings.disabledSuffix") : ""}
        </div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          {isLocalMode
            ? t("aiSettings.fullLocalEnabledDesc")
            : t("aiSettings.fullLocalDisabledDesc")}
        </div>
      </div>
      <div
        className={`w-9 h-5 rounded-full transition-colors relative ${
          isLocalMode ? "bg-purple-500" : "bg-[var(--moba-divider)]"
        }`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            isLocalMode ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}

function getDefaultRoute(task: string): string {
  const defaults: Record<string, string> = {
    voice_intent: "deepseek",
    voice_to_shell: "deepseek",
    tab_completion: "local",
    command_rewrite: "deepseek",
    chat_drawer: "deepseek",
    inline_qq: "deepseek",
    agent_default: "deepseek",
  };
  return defaults[task] ?? "deepseek";
}

import { SettingsSwitch } from "../ui/SettingsSwitch";
import { useAiStore } from "../../stores/aiStore";
import { Shield, ShieldOff } from "lucide-react";
import { useT } from "../../lib/i18n";

export function PrivacyToggle() {
  const { config, saving, saveConfig } = useAiStore();
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
    <SettingsSwitch
      data-testid="ai-full-local-toggle"
      label={t("aiSettings.fullLocal")}
      description={t(isLocalMode ? "aiSettings.fullLocalEnabledDesc" : "aiSettings.fullLocalDisabledDesc")}
      icon={isLocalMode ? <Shield className="size-5" /> : <ShieldOff className="size-5" />}
      checked={isLocalMode}
      saving={saving}
      onToggle={toggle}
    />
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

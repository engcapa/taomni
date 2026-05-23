import { useAiStore } from "../../stores/aiStore";
import { Shield, ShieldOff } from "lucide-react";

export function PrivacyToggle() {
  const { config, saveConfig } = useAiStore();

  if (!config) return null;

  // "全本地模式" = all task_routing forced to "local"
  const isLocalMode = Object.values(config.llm.task_routing).every((v) => v === "local");

  const toggle = async () => {
    const newRouting = Object.fromEntries(
      Object.keys(config.llm.task_routing).map((k) => [k, isLocalMode ? getDefaultRoute(k) : "local"])
    );
    const newConfig = {
      ...config,
      llm: { ...config.llm, task_routing: newRouting },
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
          全本地模式 {isLocalMode ? "· 已开启" : ""}
        </div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          {isLocalMode
            ? "所有 AI 任务强制走本地模型，零云端请求"
            : "开启后所有 AI 任务路由到本地模型，需先下载本地模型"}
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

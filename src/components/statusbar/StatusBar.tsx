import {
  Bot,
  Monitor,
  Wifi,
  KeyRound,
  Eye,
  Moon,
  Sun,
  Mic,
  Search,
  Shield,
  Sparkles,
  Cpu,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAppTheme } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";

export function StatusBar() {
  const { tabs, activeTabId, xServerEnabled, xServerStatus, statusMessage } = useAppStore();
  const { sessions, selectedSessionId } = useSessionStore();
  const { mode, resolvedTheme } = useAppTheme();
  const [online, setOnline] = useState(navigator.onLine);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const selected = sessions.find((session) => session.id === selectedSessionId);
  const toggleGlobalChat = useChatStore((s) => s.toggleGlobalChat);
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const drawerScope = useChatStore((s) => s.drawerScope);
  const aiConfig = useAiStore((s) => s.config);
  const activeProvider = aiConfig?.llm.active ?? "—";
  const activeAsr = aiConfig?.asr.active ?? "—";
  const fullLocal = !!aiConfig?.full_local_mode;
  const fullyDisabled = !!aiConfig?.fully_disabled;
  const ccEnabled = !!aiConfig?.cc_bridge.enabled;
  const codexEnabled = !!aiConfig?.codex_bridge.enabled;
  const searchEnabled = !!aiConfig?.web_search.client_enabled;
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const dot = (cls: string) => (
    <span className={`w-1.5 h-1.5 rounded-full ${cls}`} />
  );

  return (
    <div data-testid="status-bar" className="taomni-status h-6 flex items-center px-2 gap-3">
      <span className="flex items-center gap-1">
        <Eye className="w-3 h-3" /> {t("statusBar.sessions", { count: sessions.length })} • {selected ? selected.name : t("statusBar.none")}
      </span>
      <span className="taomni-divider-v h-3" />
      <span className="flex items-center gap-1">
        <Wifi className={`w-3 h-3 ${online ? "text-emerald-600" : "text-red-600"}`} /> {online ? t("statusBar.networkOnline") : t("statusBar.networkOffline")}
      </span>
      <span className="flex items-center gap-1" title={xServerStatus?.provider ? `${xServerStatus.provider} · ${xServerStatus.endpoint}` : undefined}>
        <Monitor className={`w-3 h-3 ${xServerEnabled ? "text-emerald-600" : "text-slate-500"}`} /> X11: {xServerEnabled ? (xServerStatus?.display || xServerStatus?.endpoint || "") : t("statusBar.x11Off")}
      </span>
      <span className="flex items-center gap-1">
        <KeyRound className="w-3 h-3 text-slate-500" /> {t("statusBar.auth")}
      </span>

      {!fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />

          {/* ASR segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={t("statusBar.asrTooltip", { provider: activeAsr })}
          >
            <Mic className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            <span className="hidden xl:inline">ASR</span>
          </span>

          {/* LLM segment */}
          <button
            type="button"
            className={`flex items-center gap-1 text-[11px] hover:text-[var(--taomni-accent)] transition-colors ${drawerOpen && drawerScope === "global" ? "text-[var(--taomni-accent)]" : ""}`}
            onClick={() => void toggleGlobalChat()}
            title={t("statusBar.globalChatTitle")}
          >
            <Bot className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            {t("statusBar.llm", { provider: activeProvider })}
          </button>

          {/* Web search segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={t("statusBar.webSearchTooltip", {
              state: searchEnabled ? t("common.enabled") : t("common.disabled"),
              provider: aiConfig?.web_search.client_provider ?? "—",
            })}
          >
            <Search className="w-3 h-3" />
            {dot(searchEnabled ? "bg-green-400" : "bg-gray-400")}
          </span>

          {/* Claude Code segment */}
          {ccEnabled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              title={t("statusBar.claudeCodeTooltip")}
            >
              <Cpu className="w-3 h-3" />
              {dot("bg-green-400")}
              CC
            </span>
          )}

          {codexEnabled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              title="Codex app-server enabled"
            >
              <Cpu className="w-3 h-3" />
              {dot("bg-green-400")}
              Codex
            </span>
          )}

          {/* Privacy segment */}
          {fullLocal && (
            <span
              className="flex items-center gap-1 text-[11px] text-purple-300"
              title={t("statusBar.fullLocalTooltip")}
            >
              <Shield className="w-3 h-3" />
              {t("statusBar.fullLocalShort")}
            </span>
          )}
        </>
      )}

      {fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />
          <span
            className="flex items-center gap-1 text-[11px] text-yellow-300"
            title={t("statusBar.aiOffTooltip")}
          >
            <Sparkles className="w-3 h-3" />
            {t("statusBar.aiOff")}
          </span>
        </>
      )}

      <div className="flex-1" />
      <span className="truncate max-w-[260px]">{statusMessage}</span>
      <span className="taomni-divider-v h-3" />
      <span className="flex items-center gap-1">
        {resolvedTheme === "dark" ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
        {t("statusBar.themeLabel", { mode: themeLabel(mode) })}
      </span>
      <span className="taomni-divider-v h-3" />
      <span className="taomni-mono">
        {activeTab?.type ?? t("statusBar.activeTabNone")} • {t("statusBar.terminalsCount", { count: tabs.filter((tab) => tab.type === "terminal").length })}
      </span>
      <span className="taomni-divider-v h-3" />
      <span>{t("statusBar.versionTag", { version: "0.2.0" })}</span>
    </div>
  );
}

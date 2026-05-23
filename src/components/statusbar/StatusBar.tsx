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
import { appThemeModeLabel, useAppTheme } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";

export function StatusBar() {
  const { tabs, activeTabId, xServerEnabled, statusMessage } = useAppStore();
  const { sessions, selectedSessionId } = useSessionStore();
  const { mode, resolvedTheme } = useAppTheme();
  const [online, setOnline] = useState(navigator.onLine);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const selected = sessions.find((session) => session.id === selectedSessionId);
  const toggleDrawer = useChatStore((s) => s.toggleDrawer);
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const aiConfig = useAiStore((s) => s.config);
  const activeProvider = aiConfig?.llm.active ?? "—";
  const activeAsr = aiConfig?.asr.active ?? "—";
  const fullLocal = !!aiConfig?.full_local_mode;
  const fullyDisabled = !!aiConfig?.fully_disabled;
  const ccEnabled = !!aiConfig?.cc_bridge.enabled;
  const searchEnabled = !!aiConfig?.web_search.client_enabled;

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
    <div data-testid="status-bar" className="moba-status h-6 flex items-center px-2 gap-3">
      <span className="flex items-center gap-1">
        <Eye className="w-3 h-3" /> {sessions.length} sessions • {selected ? selected.name : "none selected"}
      </span>
      <span className="moba-divider-v h-3" />
      <span className="flex items-center gap-1">
        <Wifi className={`w-3 h-3 ${online ? "text-emerald-600" : "text-red-600"}`} /> {online ? "Network online" : "Network offline"}
      </span>
      <span className="flex items-center gap-1">
        <Monitor className={`w-3 h-3 ${xServerEnabled ? "text-emerald-600" : "text-slate-500"}`} /> X11: {xServerEnabled ? "127.0.0.1:0.0" : "off"}
      </span>
      <span className="flex items-center gap-1">
        <KeyRound className="w-3 h-3 text-slate-500" /> auth: password/key prompt
      </span>

      {!fullyDisabled && (
        <>
          <span className="moba-divider-v h-3" />

          {/* ASR segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={`ASR: ${activeAsr}`}
          >
            <Mic className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            <span className="hidden xl:inline">ASR</span>
          </span>

          {/* LLM segment */}
          <button
            type="button"
            className={`flex items-center gap-1 text-[11px] hover:text-[var(--moba-accent)] transition-colors ${drawerOpen ? "text-[var(--moba-accent)]" : ""}`}
            onClick={toggleDrawer}
            title="AI Chat Drawer (Ctrl+L)"
          >
            <Bot className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            LLM: {activeProvider}
          </button>

          {/* Web search segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={`Web Search: ${searchEnabled ? "已启用" : "未启用"} (${aiConfig?.web_search.client_provider ?? "—"})`}
          >
            <Search className="w-3 h-3" />
            {dot(searchEnabled ? "bg-green-400" : "bg-gray-400")}
          </span>

          {/* Claude Code segment */}
          {ccEnabled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              title="Claude Code 集成已启用"
            >
              <Cpu className="w-3 h-3" />
              {dot("bg-green-400")}
              CC
            </span>
          )}

          {/* Privacy segment */}
          {fullLocal && (
            <span
              className="flex items-center gap-1 text-[11px] text-purple-300"
              title="全本地模式：所有云端调用被拒绝"
            >
              <Shield className="w-3 h-3" />
              全本地
            </span>
          )}
        </>
      )}

      {fullyDisabled && (
        <>
          <span className="moba-divider-v h-3" />
          <span
            className="flex items-center gap-1 text-[11px] text-yellow-300"
            title="AI 完全禁用"
          >
            <Sparkles className="w-3 h-3" />
            AI: 关闭
          </span>
        </>
      )}

      <div className="flex-1" />
      <span className="truncate max-w-[260px]">{statusMessage}</span>
      <span className="moba-divider-v h-3" />
      <span className="flex items-center gap-1">
        {resolvedTheme === "dark" ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
        Theme: {appThemeModeLabel(mode)}
      </span>
      <span className="moba-divider-v h-3" />
      <span className="moba-mono">{activeTab?.type ?? "none"} • {tabs.filter((tab) => tab.type === "terminal").length} terminals</span>
      <span className="moba-divider-v h-3" />
      <span>v0.1.0 • MVP</span>
    </div>
  );
}

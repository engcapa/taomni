import { taoText as tr } from "../i18n";
import { useTaoText } from "../i18n";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTauriRuntime } from "../../../lib/runtime";
import { nativeThreadStorage } from "../ai-chat/backend";
import { useAiStore } from "../../../stores/aiStore";
import type { WelcomePanelProps } from "../../welcome/types";
import { createChatController, deepSeekAppBackend, TaoAiChat, type ContextPorts, type ChatProfile, type TaoSearchResult } from "../ai-chat";
import { NoKeyCard } from "./NoKeyCard";
import { BindingBar } from "./BindingBar";
import { DockRow } from "./DockRow";
import { SuggestionRow } from "./SuggestionRow";
import { SearchPanel } from "../search/SearchPanel";
import { redactText } from "../redact";
import { openSettingsSection } from "../../../lib/settingsNavigation";
import { createNativeActionPorts } from "../ai-chat/nativeCapabilities";

const PROFILE: ChatProfile = {
  modes: [
    { id: "ask", label: "问", description: "解释、总结、回答开发问题" },
    { id: "do", label: "做", description: "提出动作并等待你的确认" },
    { id: "research", label: "深研", description: "生成计划并多轮研究" },
  ],
  sidePanels: ["来源", "文件", "生成物", "工作流", "语音", "导入导出", "记忆", "技能"],
  defaultModel: "deepseek-flash",
  defaultThinking: false,
  defaultWeb: false,
  budget: { limitTokens: 10_000_000, costConfirmThresholdCny: 0.5 },
};

export function TaoHomeHost(props: WelcomePanelProps) {
  useTaoText();
  const [storageError, setStorageError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(isTauriRuntime());
  const controllerRef = useRef<ReturnType<typeof createChatController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createChatController({ backend: deepSeekAppBackend, profile: PROFILE, actionPorts: createNativeActionPorts("tao-action") });
  const controller = controllerRef.current;
  const aiConfig = useAiStore((state) => state.config);
  const loadAiConfig = useAiStore((state) => state.loadConfig);
  const saveConfig = useAiStore((state) => state.saveConfig);
  const updateProvider = useAiStore((state) => state.updateLlmProvider);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const demoMode = state.ui.demoMode;
  useEffect(() => {
    const config = aiConfig?.deepseek_app;
    if (config) controller.setDefaults({ defaultModel: config.model === "deepseek-v4-pro" ? config.model : config.provider === "opencode-go" ? "deepseek-v4.1-flash" : "deepseek-flash", defaultProvider: config.provider ?? "deepseek-app", defaultReasoningEffort: config.reasoning_effort ?? "high", defaultThinking: config.thinking_default, defaultWeb: config.search_default });
  }, [aiConfig?.deepseek_app, controller]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    const save = () => {
      if (!loaded) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const thread of Object.values(controller.getState().threads)) {
          // Legacy ChatDrawer rows are read-only history pointers. Keep their
          // source table authoritative and never migrate them into Tao's store.
          if (thread.source === "legacy") continue;
          void nativeThreadStorage.save(thread).catch((error) => { if (!disposed) setStorageError(tr("历史保存失败：{error}", { error: String(error) })); });
        }
      }, 180);
    };
    const unsubscribe = controller.subscribe(save);
    void nativeThreadStorage.load().then((threads) => {
      if (disposed) return;
      controller.hydrateThreads(threads); loaded = true; setLoadingHistory(false); save();
    }).catch((error) => { if (!disposed) { setStorageError(tr("历史读取失败：{error}", { error: String(error) })); loaded = true; setLoadingHistory(false); } });
    return () => { disposed = true; unsubscribe(); clearTimeout(timer); };
  }, [controller]);
  useEffect(() => { if (!aiConfig) void loadAiConfig().catch(() => undefined); }, [aiConfig, loadAiConfig]);
  const oldKey = aiConfig?.llm.providers.deepseek?.api_key ?? "";
  const providerId = state.composer.provider ?? "deepseek-app";
  const taoProvider = aiConfig?.llm.providers[providerId];
  const taoKey = taoProvider?.api_key ?? "";
  const hasTaoKey = Boolean(taoKey || taoProvider?.api_keys?.some((key) => key.trim()));
  const canReuse = providerId === "deepseek-app" && Boolean(oldKey && !taoKey);
  const contextPorts = useMemo<ContextPorts>(() => ({
    search: async (query: string): Promise<TaoSearchResult[]> => {
      const current = controller.getState();
      const records: TaoSearchResult[] = [];
      Object.values(current.threads).forEach((thread) => {
        const body = thread.messages.map((message) => message.text).filter(Boolean).join("\n");
        if (!body) return;
        const safe = redactText(body);
        records.push({ id: `thread:${thread.id}`, source: "thread", ref: thread.id, title: thread.title, body: safe.text, ts: thread.updatedAt, useCount: 0, redactedCount: safe.count });
      });
      (props.recentSessions ?? []).forEach((session) => {
        const body = redactText(`${session.name ?? ""} ${session.host ?? ""}`).text.trim();
        if (body) records.push({ id: `session:${session.id}`, source: "session", ref: session.id, title: session.name || session.host || "会话", body, host: session.host, ts: session.last_connected_at ?? undefined });
      });
      (props.recentWorkspaces ?? []).forEach((workspace) => {
        const body = redactText(workspace.roots.map((root) => root.path).join("\n")).text;
        records.push({ id: `workspace:${workspace.id}`, source: "workspace", ref: workspace.id, title: workspace.name, body, ts: workspace.lastOpenedAt });
      });
      // Keep the port asynchronous so a native index can replace this
      // in-memory fallback without changing the SearchPanel contract.
      void query;
      return records;
    },
  }), [controller, props.recentSessions, props.recentWorkspaces]);
  const threads = Object.values(state.threads).sort((a, b) => b.updatedAt - a.updatedAt);
  const handleReuse = () => {
    if (!aiConfig || !oldKey) return;
    const old = aiConfig.llm.providers.deepseek;
    if (!old) return;
    const next = { ...old, base_url: "https://api.deepseek.com", model: "deepseek-flash", runtime: "deepseek-messages" };
    void saveConfig({ ...aiConfig, llm: { ...aiConfig.llm, providers: { ...aiConfig.llm.providers, "deepseek-app": next } } }).then(() => updateProvider("deepseek-app", next)).catch((error) => setStorageError(tr("保存 Key 失败：{error}", { error: String(error) })));
  };
  const openSettings = () => { openSettingsSection("ai-tao"); props.onOpenSettings?.(); };
  const openAppearance = () => { openSettingsSection("app-theme"); props.onOpenSettings?.(); };
  return <div className="tao-home-host" data-testid="tao-home-host" data-tao-home-host="true"><div className="tao-home-legacy-panel" data-testid="welcome-panel"><TaoAiChat controller={controller} profile={PROFILE} disabled={loadingHistory || !hasTaoKey || !isTauriRuntime() || aiConfig?.deepseek_app?.enabled === false} active={props.active !== false} onOpenSettings={openSettings} onOpenAppearance={openAppearance} slots={{ headerTrailing: <BindingBar controller={controller} context={state.context} />, emptyState: <>{!isTauriRuntime() ? <p data-testid="tao-home-browser-unavailable">{tr("浏览器预览不提供 DeepSeek 原生对话，请在桌面应用中使用。")}</p> : null}{!hasTaoKey ? <NoKeyCard onOpenSettings={openSettings} onReuse={handleReuse} canReuse={canReuse} /> : null}{storageError ? <p role="alert">{storageError}</p> : null}</>, belowComposer: <><SuggestionRow controller={controller} hidden={demoMode} /><DockRow {...props} onOpenSettings={openSettings} controller={controller} threads={threads} demoMode={demoMode} /></> }} />{state.ui.searchOpen && props.active !== false ? <SearchPanel controller={controller} contextPorts={contextPorts} onClose={() => controller.setSearchOpen(false)} /> : null}</div></div>;
}

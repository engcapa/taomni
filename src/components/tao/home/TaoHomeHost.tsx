import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAiStore } from "../../../stores/aiStore";
import type { WelcomePanelProps } from "../../welcome/types";
import { createChatController, deepSeekAppBackend, TaoAiChat, type ContextPorts, type ChatProfile, type TaoSearchResult } from "../ai-chat";
import { NoKeyCard } from "./NoKeyCard";
import { BindingBar } from "./BindingBar";
import { DockRow } from "./DockRow";
import { SuggestionRow } from "./SuggestionRow";
import { SearchPanel } from "../search/SearchPanel";
import { redactText } from "../redact";

const PROFILE: ChatProfile = {
  modes: [
    { id: "ask", label: "问", description: "解释、总结、回答开发问题" },
    { id: "do", label: "做", description: "提出动作并等待你的确认" },
    { id: "research", label: "深研", description: "生成计划并多轮研究" },
  ],
  sidePanels: ["来源", "文件", "生成物", "工作流"],
  defaultModel: "deepseek-flash",
  defaultThinking: false,
  defaultWeb: false,
  budget: { limitTokens: 10_000_000, costConfirmThresholdCny: 0.5 },
};

export function TaoHomeHost(props: WelcomePanelProps) {
  const controllerRef = useRef<ReturnType<typeof createChatController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createChatController({ backend: deepSeekAppBackend, profile: PROFILE });
  const controller = controllerRef.current;
  const aiConfig = useAiStore((state) => state.config);
  const loadAiConfig = useAiStore((state) => state.loadConfig);
  const saveConfig = useAiStore((state) => state.saveConfig);
  const updateProvider = useAiStore((state) => state.updateLlmProvider);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const demoMode = state.ui.demoMode;
  useEffect(() => { if (!aiConfig) void loadAiConfig().catch(() => undefined); }, [aiConfig, loadAiConfig]);
  const oldKey = aiConfig?.llm.providers.deepseek?.api_key ?? "";
  const taoProvider = aiConfig?.llm.providers["deepseek-app"];
  const taoKey = taoProvider?.api_key ?? "";
  const hasTaoKey = Boolean(taoKey || taoProvider?.api_keys?.some((key) => key.trim()));
  const canReuse = Boolean(oldKey && !taoKey);
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
    updateProvider("deepseek-app", next);
    void saveConfig({ ...aiConfig, llm: { ...aiConfig.llm, providers: { ...aiConfig.llm.providers, "deepseek-app": next } } }).catch(() => undefined);
  };
  const openSettings = props.onOpenSettings;
  return <div className="tao-home-host" data-testid="tao-home-host" data-tao-home-host="true"><div className="tao-home-legacy-panel" data-testid="welcome-panel"><TaoAiChat controller={controller} profile={PROFILE} disabled={!hasTaoKey} onOpenSettings={openSettings} slots={{ composerContext: <BindingBar controller={controller} context={state.context} />, emptyState: <>{!hasTaoKey ? <NoKeyCard onOpenSettings={canReuse ? handleReuse : openSettings} canReuse={canReuse} /> : <SuggestionRow controller={controller} hidden={demoMode} />}</>, belowComposer: <DockRow controller={controller} threads={threads} sessions={props.recentSessions ?? []} workspaces={props.recentWorkspaces ?? []} demoMode={demoMode} onStartLocalTerminal={(shell) => void props.onStartLocalTerminal(shell)} onNewSession={props.onNewSession} onOpenNewWorkspace={props.onOpenNewWorkspace} onOpenRecentSession={props.onOpenRecentSession} onOpenRecentWorkspace={props.onOpenRecentWorkspace} onRestore={props.restore?.onStartRestore} onOpenSettings={openSettings} />, sidePanels: <div className="tao-home-side-placeholder">来源与本地资料会显示在这里。</div> }} />{state.ui.searchOpen ? <SearchPanel controller={controller} contextPorts={contextPorts} onClose={() => controller.setSearchOpen(false)} /> : null}<button type="button" className="tao-home-demo-toggle" data-testid="tao-home-demo-toggle" aria-pressed={demoMode} onClick={() => controller.setDemoMode(!demoMode)}>演示模式</button>{canReuse ? <button type="button" className="tao-home-reuse-key" hidden onClick={handleReuse}>沿用已有 Key</button> : null}</div></div>;
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, LayoutGrid, Search, X } from "lucide-react";
import { buildTabDetailSummary } from "../../lib/tabDetails";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { filterOverviewItems, type PreviewItem } from "./overview/overviewModel";
import { useTerminalPreviews } from "./overview/useTerminalPreviews";
import { OverviewSummary } from "./overview/OverviewSummary";

/** Mode-scoped, live text overview. Reading a preview never starts a session. */
export function TabOverview() {
  const open = useTabOverviewStore((s) => s.open);
  return open ? <OpenTabOverview /> : null;
}

function OpenTabOverview() {
  const t = useT();
  const mode = useAppStore((s) => s.activeSideTab);
  const tabs = useAppStore((s) => s.tabs);
  const activeId = useAppStore((s) => s.activeTabId);
  const runtimes = useAppStore((s) => s.terminalRuntimeByTab);
  const cwds = useAppStore((s) => s.cwdByTab);
  const sessions = useSessionStore((s) => s.sessions);
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const documents = useWorkspaceEditorStore((s) => s.documents);
  const [all, setAll] = useState(mode !== "sessions" && mode !== "workspaces");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useTabOverviewStore((s) => s.close);
  const previews = useTerminalPreviews([
    ...(all || mode === "sessions" ? tabs.map((tab) => tab.id) : []),
    ...(all || mode === "workspaces" ? workspaces.filter((ws) => all || ws.id === activeWorkspaceId)
      .flatMap((ws) => ws.openTabs.map((tab) => tab.id)) : []),
  ]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button, input, [tabindex]") ?? [])
          .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && !element.closest("[hidden]"));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); };
  }, [close]);

  const items: PreviewItem[] = [];
  if (all || mode === "sessions") {
    for (const tab of tabs.filter((candidate) => candidate.type !== "welcome")) {
      const detail = buildTabDetailSummary(tab, sessions, runtimes[tab.id], cwds[tab.id], t);
      const preview = previews.get(tab.id);
      items.push({ id: tab.id, title: tab.title, kind: detail.connectionLabel, group: t("platform.sessions"),
        endpoint: detail.endpoint ?? detail.cwd ?? "", summary: preview?.text || [detail.sessionLabel, detail.activityLabel].join("\n"),
        active: mode === "sessions" && activeId === tab.id, outputActive: preview?.outputActive ?? false, followLatest: !!preview?.text });
    }
  }
  if (all || mode === "workspaces") {
    for (const workspace of workspaces.filter((candidate) => all || candidate.id === activeWorkspaceId)) {
      for (const tab of workspace.openTabs) {
        const session = sessions.find((candidate) => candidate.id === tab.sessionId);
        const doc = documents[tab.id];
        const preview = previews.get(tab.id);
        items.push({ id: tab.id, title: tab.title, kind: tab.protocol ?? tab.kind.toUpperCase(), group: workspace.name, workspaceId: workspace.id,
          endpoint: session?.host ?? tab.filePath ?? tab.focusPath ?? "",
          summary: preview?.text || doc?.text.slice(0, 1800) || [workspace.name, tab.filePath ?? session?.name ?? tab.title].join("\n"),
          active: mode === "workspaces" && workspace.id === activeWorkspaceId && tab.id === workspace.activeTabId,
          outputActive: preview?.outputActive ?? false, followLatest: !!preview?.text });
      }
    }
  }
  const matching = filterOverviewItems(items, query);
  const activate = (item: PreviewItem) => {
    const app = useAppStore.getState();
    const sameMode = app.activeSideTab === (item.workspaceId ? "workspaces" : "sessions");
    const sidebarCollapsed = app.sidebarCollapsed;
    if (item.workspaceId) {
      const store = useWorkspacePlatformStore.getState();
      store.setActiveWorkspace(item.workspaceId);
      store.setActiveWorkspaceTab(item.workspaceId, item.id);
      if (!sameMode) app.setActiveSideTab("workspaces");
    } else {
      useAppStore.getState().setTabFilter(null);
      useAppStore.getState().setActiveTab(item.id);
      if (!sameMode) app.setActiveSideTab("sessions");
    }
    if (sameMode) app.setSidebarCollapsed(sidebarCollapsed);
    close();
  };
  return createPortal(
    <div ref={dialogRef} data-testid="tab-overview" data-scope={all ? "all" : mode} role="dialog" aria-modal="true" aria-labelledby="tab-overview-title" className="taomni-tab-overview">
      <div className="taomni-overview-header">
        <div><h2 id="tab-overview-title" className="flex items-center gap-2 text-[16px] font-bold"><LayoutGrid className="h-4 w-4" />{t("platform.tabOverview")}<kbd className="text-[11px] font-normal">Ctrl/Cmd+Shift+E</kbd></h2><p className="mt-1 text-[12px] text-[var(--taomni-text-muted)]">{t("platform.overviewHint")}</p></div>
        <button data-testid="tab-overview-close" className="taomni-btn" onClick={close}><X className="mr-1 h-3 w-3" />{t("common.close")} (Esc)</button>
      </div>
      <div className="taomni-overview-search-row">
        <div className="taomni-overview-search">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input ref={searchRef} data-testid="tab-overview-search" type="search" maxLength={200} value={query}
            aria-label={t("platform.overviewSearch")} placeholder={t("platform.overviewSearch")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229 && matching[0]) {
                event.preventDefault(); activate(matching[0]);
              }
            }} />
          {query && <button data-testid="tab-overview-search-clear" type="button" aria-label={t("platform.overviewClearSearch")}
            onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X className="h-4 w-4" /></button>}
        </div>
        <span data-testid="tab-overview-results" className="shrink-0 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.overviewResults", { visible: matching.length, total: items.length })}</span>
      </div>
      {(mode === "sessions" || mode === "workspaces") && <div className="mb-3 flex gap-2">
        <button data-testid="tab-overview-current" className="taomni-toolbar-pill" aria-pressed={!all} onClick={() => setAll(false)}>{t("platform.overviewCurrent")}</button>
        <button data-testid="tab-overview-all" className="taomni-toolbar-pill" aria-pressed={all} onClick={() => setAll(true)}>{t("platform.overviewAll")}</button>
      </div>}
      <div className="taomni-overview-grid">
        {matching.map((item) => <button key={item.id} data-testid="tab-overview-card" data-tab-id={item.id} data-workspace-id={item.workspaceId}
          data-active={item.active || undefined} data-output-active={item.outputActive || undefined} className="taomni-overview-card" onClick={() => activate(item)}>
          <span className="taomni-overview-card-header"><span className="taomni-overview-kind">{item.kind}</span><strong className="min-w-0 flex-1 truncate">{item.title}</strong>
            {item.outputActive && <span data-testid="tab-overview-output-badge" className="taomni-overview-output-badge"><Activity className="h-3 w-3" aria-hidden="true" />{t("platform.overviewNewOutput")}</span>}
            <span className="max-w-[45%] truncate text-[10px] text-[var(--taomni-text-muted)]">{item.endpoint}</span></span>
          <OverviewSummary text={item.summary} followLatest={!!item.followLatest} />
          <span className="px-3 py-1 text-[10px] text-[var(--taomni-text-muted)]">{item.group}</span>
        </button>)}
      </div>
      {matching.length === 0 && <p data-testid="tab-overview-empty" className="p-12 text-center text-[var(--taomni-text-muted)]">{t(items.length ? "platform.overviewNoMatch" : "platform.overviewEmpty")}</p>}
    </div>, document.body,
  );
}

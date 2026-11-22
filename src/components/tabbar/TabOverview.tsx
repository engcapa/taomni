import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, LayoutGrid, Search, X } from "lucide-react";
import { buildTabDetailSummary } from "../../lib/tabDetails";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { filterOverviewItems, type PreviewItem } from "./overview/overviewModel";
import { useTerminalPreviews } from "./overview/useTerminalPreviews";
import { OverviewSummary } from "./overview/OverviewSummary";
import { OverviewTitle } from "./overview/OverviewTitle";
import { focusOverviewCard, moveOverviewFocus } from "./overview/overviewNavigation";
import { useOverviewPreview } from "./overview/useOverviewPreview";

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
  const explorerTabs = useExplorerStore((s) => s.tabs);
  const explorerActiveTabId = useExplorerStore((s) => s.activeTabId);
  const localPanes = useSftpStore((s) => s.sessions);
  const documents = useWorkspaceEditorStore((s) => s.documents);
  const [all, setAll] = useState(mode !== "sessions" && mode !== "workspaces" && mode !== "explorer");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const enlargedRef = useRef<HTMLDivElement>(null);
  const { preview, hover, clear: clearPreview } = useOverviewPreview();
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
        clearPreview();
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button, input, [tabindex]") ?? [])
          .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && !element.closest("[hidden]"));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); };
  }, [close, clearPreview]);
  useEffect(() => { clearPreview(); }, [all, mode, query, clearPreview]);

  const items: PreviewItem[] = [];
  if (all || mode === "sessions") {
    for (const tab of tabs.filter((candidate) => candidate.type !== "welcome")) {
      const detail = buildTabDetailSummary(tab, sessions, runtimes[tab.id], cwds[tab.id], t);
      const preview = previews.get(tab.id);
      items.push({ id: tab.id, title: tab.title, kind: detail.connectionLabel, group: t("platform.sessions"), surface: "sessions",
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
        items.push({ id: tab.id, title: tab.title, kind: tab.protocol ?? tab.kind.toUpperCase(), group: workspace.name, workspaceId: workspace.id, surface: "workspaces",
          endpoint: session?.host ?? tab.filePath ?? tab.focusPath ?? "",
          summary: preview?.text || doc?.text.slice(0, 1800) || [workspace.name, tab.filePath ?? session?.name ?? tab.title].join("\n"),
          active: mode === "workspaces" && workspace.id === activeWorkspaceId && tab.id === workspace.activeTabId,
          outputActive: preview?.outputActive ?? false, followLatest: !!preview?.text });
      }
    }
  }
  if (all || mode === "explorer") {
    for (const tab of explorerTabs) {
      const pane = localPanes[tab.id]?.local;
      const endpoint = pane?.path || tab.fileBrowser?.initialPath || tab.fileViewer?.path || "";
      const doc = tab.fileViewer ? documents[tab.fileViewer.path] : undefined;
      const itemCount = tab.type === "file-browser" ? pane?.entries.length : undefined;
      items.push({ id: tab.id, title: tab.title, kind: tab.type === "file-browser" ? "EXPL" : "VIEW", group: t("menu.fileExplorer"),
        surface: "explorer", endpoint,
        summary: doc?.text.slice(0, 1800) || [endpoint, itemCount != null ? t("platform.overviewExplorerItems", { count: itemCount }) : ""].filter(Boolean).join("\n"),
        active: mode === "explorer" && explorerActiveTabId === tab.id, outputActive: false });
    }
  }
  const matching = filterOverviewItems(items, query);
  const previewItem = preview && matching.find((item) => item.id === preview.id);
  const previewWidth = preview ? Math.min(Math.max(440, preview.bounds.width * 1.45), window.innerWidth - 24) : 0;
  const activate = (item: PreviewItem) => {
    const app = useAppStore.getState();
    const surface = item.surface ?? (item.workspaceId ? "workspaces" : "sessions");
    const sameMode = app.activeSideTab === surface;
    const sidebarCollapsed = app.sidebarCollapsed;
    if (surface === "explorer") {
      useExplorerStore.getState().setActiveTab(item.id);
    } else if (item.workspaceId) {
      const store = useWorkspacePlatformStore.getState();
      store.setActiveWorkspace(item.workspaceId);
      store.setActiveWorkspaceTab(item.workspaceId, item.id);
    } else {
      useAppStore.getState().setTabFilter(null);
      useAppStore.getState().setActiveTab(item.id);
    }
    if (!sameMode) app.setActiveSideTab(surface);
    if (sameMode) app.setSidebarCollapsed(sidebarCollapsed);
    close();
  };
  return createPortal(
    <div ref={dialogRef} data-testid="tab-overview" data-scope={all ? "all" : mode} role="dialog" aria-modal="true" aria-labelledby="tab-overview-title" className="taomni-tab-overview" onScroll={clearPreview}>
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
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && focusOverviewCard(gridRef.current, event.key === "ArrowUp")) {
                event.preventDefault();
                clearPreview();
              }
              if (event.key === "Enter" && matching[0]) {
                event.preventDefault(); activate(matching[0]);
              }
            }} />
          {query && <button data-testid="tab-overview-search-clear" type="button" aria-label={t("platform.overviewClearSearch")}
            onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X className="h-4 w-4" /></button>}
        </div>
        <span data-testid="tab-overview-results" className="shrink-0 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.overviewResults", { visible: matching.length, total: items.length })}</span>
      </div>
      {(mode === "sessions" || mode === "workspaces" || mode === "explorer") && <div className="mb-3 flex gap-2">
        <button data-testid="tab-overview-current" className="taomni-toolbar-pill" aria-pressed={!all} onClick={() => setAll(false)}>{t("platform.overviewCurrent")}</button>
        <button data-testid="tab-overview-all" className="taomni-toolbar-pill" aria-pressed={all} onClick={() => setAll(true)}>{t("platform.overviewAll")}</button>
      </div>}
      <div ref={gridRef} className="taomni-overview-grid" onKeyDown={(event) => { moveOverviewFocus(event); if (event.defaultPrevented) clearPreview(); }}>
        {matching.map((item) => <button key={item.id} type="button" data-testid="tab-overview-card" data-tab-id={item.id} data-workspace-id={item.workspaceId} data-surface={item.surface}
          data-active={item.active || undefined} data-output-active={item.outputActive || undefined} className="taomni-overview-card"
          onMouseEnter={(event) => hover(item.id, event.currentTarget)}
          onMouseLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !enlargedRef.current?.contains(event.relatedTarget)) clearPreview();
          }} onClick={() => activate(item)} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === " " || event.key === "Enter") event.preventDefault();
            if (event.key === "Enter") activate(item);
          }}>
          <OverviewCardContents item={item} outputLabel={t("platform.overviewNewOutput")} />
        </button>)}
      </div>
      {preview && previewItem && createPortal(
        <div ref={enlargedRef} aria-hidden="true" data-testid="tab-overview-enlarged" data-tab-id={previewItem.id} className="taomni-overview-card taomni-overview-enlarged"
          onMouseLeave={clearPreview} onClick={() => activate(previewItem)}
          style={{ width: previewWidth,
            left: Math.max(12, Math.min(preview.bounds.left + (preview.bounds.width - previewWidth) / 2, window.innerWidth - previewWidth - 12)),
            top: Math.max(12, Math.min(preview.bounds.top, window.innerHeight - Math.min(460, window.innerHeight * 0.67) - 12)) }}>
          <OverviewCardContents item={previewItem} outputLabel={t("platform.overviewNewOutput")} />
        </div>, document.body)}
      {matching.length === 0 && <p data-testid="tab-overview-empty" className="p-12 text-center text-[var(--taomni-text-muted)]">{t(items.length ? "platform.overviewNoMatch" : "platform.overviewEmpty")}</p>}
    </div>, document.body,
  );
}

function OverviewCardContents({ item, outputLabel }: { item: PreviewItem; outputLabel: string }) {
  return <>
    <span className="taomni-overview-card-header"><span className="taomni-overview-kind">{item.kind}</span><OverviewTitle title={item.title} />
      {item.outputActive && <span data-testid="tab-overview-output-badge" className="taomni-overview-output-badge"><Activity className="h-3 w-3" aria-hidden="true" />{outputLabel}</span>}</span>
    <OverviewSummary text={item.summary} followLatest={!!item.followLatest} />
    <span className="taomni-overview-card-footer">
      <span className={item.endpoint ? "min-w-0 max-w-[48%] shrink-0 truncate" : "min-w-0 truncate"}>{item.group}</span>
      {item.endpoint && <span className="min-w-0 flex-1 truncate text-right" title={item.endpoint}>{item.endpoint}</span>}
    </span>
  </>;
}

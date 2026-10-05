import { useEffect, useMemo, useRef, useState } from "react";
import { X, Pin, PinOff, MoreHorizontal, Info } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useRdpStore } from "../../stores/rdpStore";
import { useVncStore } from "../../stores/vncStore";
import { TAB_LANES, type TabLane } from "../../lib/shell/types";
import { matchesTabSearch, presentTab } from "../../lib/shell/tabPresentation";
import { filterVisibleTabs } from "../../lib/tabFilter";
import { showShellTabMenu } from "../../lib/shell/tabMenu";
import { requestTabClose } from "../../lib/shell/closeCoordinator";
import { TabIcon } from "../tabbar/TabBar";

export function TabNavigator({ onNewSession }: { onNewSession(): void }) {
  const shell = useShellLayoutStore(), app = useAppStore(), t = useT();
  const { tabs, activeTabId: activeId } = app;
  const sessions = useSessionStore((s) => s.sessions);
  const rdp = useRdpStore((s) => s.connections), vnc = useVncStore((s) => s.connections);
  const [query, setQuery] = useState(""), [lane, setLane] = useState<TabLane | "all">("all");
  const [attention, setAttention] = useState(false), [sort, setSort] = useState("recent"), [index, setIndex] = useState(0), [details, setDetails] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null), dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null), frozenMru = useRef(shell.mru);
  const locatePending = useRef(false);
  const isOpen = shell.overlay === "overview" || shell.overlay === "quick", quick = shell.overlay === "quick";
  useEffect(() => {
    if (!isOpen) return;
    opener.current = document.activeElement as HTMLElement;
    frozenMru.current = useShellLayoutStore.getState().mru;
    setQuery(""); setLane("all"); setAttention(false); setSort("recent"); setIndex(0); setDetails(null);
    searchRef.current?.focus();
    const dialog = dialogRef.current;
    return () => {
      // An action can transfer focus to a new control while closing this
      // dialog, such as the tab rename input. Preserve that action's focus.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.isConnected
        && !dialog?.contains(active) && !active.closest('[inert],[aria-hidden="true"]')) return;
      const previous = opener.current;
      const fallback = document.querySelector<HTMLElement>('[data-testid="tab-item"][data-active="true"], [data-testid="shell-rail-home"]');
      if (previous?.isConnected && !previous.closest('[inert],[aria-hidden="true"]')) previous.focus({ preventScroll: true });
      else fallback?.focus({ preventScroll: true });
    };
  }, [isOpen]);
  useEffect(() => { if (isOpen) searchRef.current?.focus(); }, [quick, isOpen]);
  const rows = useMemo(() => tabs.map((tab) => {
    const remote = tab.type === "rdp" ? rdp[tab.id] : tab.type === "vnc" ? vnc[tab.id] : undefined;
    const terminal = app.terminalRuntimeByTab[tab.id], workspace = app.codeWorkspaceByTab[tab.id];
    const secondary = remote ? `${remote.status} · ${remote.width} × ${remote.height}`
      : terminal ? `${terminal.state} · ${app.cwdByTab[tab.id] ?? tab.localShell?.name ?? ""}` : workspace?.activePath ?? tab.db?.engine ?? tab.mail?.emailAddress;
    return { tab, presentation: presentTab(tab, { active: tab.id === activeId, pinned: shell.pinnedTabs[tab.id], override: shell.laneOverrides[tab.id],
      dirty: !!workspace?.dirtyPaths.length, busy: terminal?.state === "running" || terminal?.state === "connecting" || remote?.status === "connecting", error: remote?.error, secondary }) };
  }), [tabs, activeId, shell.pinnedTabs, shell.laneOverrides, app.terminalRuntimeByTab, app.codeWorkspaceByTab, app.cwdByTab, rdp, vnc]);
  const results = useMemo(() => {
    const allowed = new Set(filterVisibleTabs(tabs, sessions, app.tabFilter).map((tab) => tab.id));
    const rank = (id: string) => frozenMru.current.includes(id) ? frozenMru.current.indexOf(id) : tabs.length;
    return rows.filter(({ tab, presentation }) => {
      const session = sessions.find((item) => item.id === tab.sessionId);
      return allowed.has(tab.id) && matchesTabSearch(tab, query, [session?.name ?? "", session?.group_path ?? "", presentation.preview.secondary ?? ""])
        && (lane === "all" || presentation.lane === lane) && (!attention || presentation.attention !== "none");
    }).sort((a, b) => (sort === "name" ? a.tab.title.localeCompare(b.tab.title) : sort === "type" ? a.tab.type.localeCompare(b.tab.type) : rank(a.tab.id) - rank(b.tab.id))
      || tabs.indexOf(a.tab) - tabs.indexOf(b.tab) || a.tab.id.localeCompare(b.tab.id));
  }, [tabs, sessions, app.tabFilter, rows, query, lane, attention, sort]);
  useEffect(() => { setIndex((old) => Math.min(old, Math.max(0, results.length - 1))); }, [results.length]);
  useEffect(() => {
    if (locatePending.current) {
      const current = results.findIndex((row) => row.tab.id === activeId);
      if (current >= 0) {
        locatePending.current = false;
        setIndex(current);
        dialogRef.current?.querySelector<HTMLElement>(`[data-result-index="${current}"] [data-testid="shell-tab-card-open"]`)?.focus();
        dialogRef.current?.querySelector<HTMLElement>(`[data-result-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
    dialogRef.current?.querySelector<HTMLElement>(`[data-result-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, results, activeId, isOpen]);
  if (!isOpen) return null;
  const clear = () => { setQuery(""); setLane("all"); setAttention(false); useAppStore.getState().setTabFilter(null); };
  const activate = (id: string) => { useAppStore.getState().setActiveTab(id); shell.visitTab(id); shell.setOverlay(null); };
  const close = async (id: string) => {
    const result = await requestTabClose([id]);
    if (!result.closed.includes(id)) return;
    const position = results.findIndex((row) => row.tab.id === id), live = new Set(useAppStore.getState().tabs.map((tab) => tab.id));
    const next = results.slice(position + 1).find((row) => live.has(row.tab.id)) ?? results.slice(0, position).reverse().find((row) => live.has(row.tab.id));
    requestAnimationFrame(() => {
      const card = next && dialogRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.tab.id)}"] [data-testid="shell-tab-card-open"]`);
      if (card) card.focus({ preventScroll: true }); else searchRef.current?.focus();
    });
  };
  return <div data-testid="shell-tab-backdrop" className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center pt-12 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) shell.setOverlay(null); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t(quick ? "shell.quickSwitch" : "shell.overview")} data-testid={quick ? "shell-quick-dialog" : "shell-overview"}
      className="flex flex-col min-w-0 rounded border shadow-xl max-h-[calc(100vh-96px)]" style={{ width: quick ? 640 : 980, maxWidth: "100%", background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)", borderColor: "var(--taomni-divider)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || document.querySelector('[data-testid="context-menu"],[data-testid="shell-close-dialog"]')) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); shell.setOverlay(null); }
        const grid = !quick && (event.target as Element).closest('[data-testid="shell-tab-card"]');
        const gridNode = dialogRef.current?.querySelector<HTMLElement>(".shell-tab-grid");
        const columns = grid && gridNode ? getComputedStyle(gridNode).gridTemplateColumns.split(" ").length : 1;
        const delta = event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : grid && event.key === "ArrowRight" ? 1 : grid && event.key === "ArrowLeft" ? -1 : 0;
        if (delta || grid && ["Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? results.length - 1 : Math.max(0, Math.min(results.length - 1, index + delta));
          setIndex(next);
          if (grid) dialogRef.current?.querySelector<HTMLElement>(`[data-result-index="${next}"] [data-testid="shell-tab-card-open"]`)?.focus();
        }
        if (event.key === "Enter" && event.target === searchRef.current && results[index]) { event.preventDefault(); activate(results[index].tab.id); }
        if (event.key === "Tab") {
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input,select") ?? [])].filter((el) => el.getBoundingClientRect().width > 0);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="p-3 border-b border-[var(--taomni-divider)] shrink-0">
        <div className="flex gap-2 items-center"><input ref={searchRef} data-testid={quick ? "shell-quick-input" : "shell-tab-search"} role={quick ? "combobox" : undefined}
          aria-expanded={quick || undefined} aria-controls={quick ? "shell-quick-results" : undefined} aria-autocomplete={quick ? "list" : undefined}
          aria-activedescendant={quick && results[index] ? `shell-result-${index}` : undefined} aria-label={t("shell.search")} placeholder={t("shell.search")} value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }} className="taomni-input flex-1 min-w-0" />
          {quick && <button data-testid="shell-quick-overview" onClick={() => shell.setOverlay("overview")}>{t("shell.overview")}</button>}
          <button type="button" data-testid="shell-tab-navigator-close" aria-label={t("common.close")} className="w-[28px] h-[28px] shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => shell.setOverlay(null)}><X className="w-5 h-5" /></button></div>
        {!quick && <div className="flex flex-wrap gap-2 mt-2 text-xs">
          <select data-testid="shell-tab-lane-filter" aria-label={t("shell.lane")} value={lane} onChange={(e) => setLane(e.target.value as TabLane | "all")} className="taomni-input"><option value="all">{t("shell.all")}</option>{TAB_LANES.map((l) => <option key={l} value={l}>{t(`shell.lanes.${l}`)}</option>)}</select>
          <label><input data-testid="shell-tab-attention-filter" type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> {t("shell.attention")}</label>
          <select data-testid="shell-tab-sort" aria-label={t("shell.sort")} value={sort} onChange={(e) => setSort(e.target.value)} className="taomni-input">{["recent", "name", "type"].map((s) => <option value={s} key={s}>{t(`shell.${s}`)}</option>)}</select>
          <span data-testid="shell-tab-count" data-total={tabs.length} data-results={results.length}>{t("shell.tabCount", { count: tabs.length })}</span>
        </div>}
        {!results.some(({ tab }) => tab.id === activeId) && <div className="text-xs mt-2"><span>{t("shell.currentExcluded")}</span><button data-testid="shell-tab-current" onClick={() => { locatePending.current = true; clear(); }}>{t("shell.locateCurrent")}</button></div>}
      </div>
      <div id="shell-quick-results" role={quick ? "listbox" : undefined} className={quick ? "overflow-auto p-2" : "overflow-auto p-3 grid gap-3 shell-tab-grid"}>
        {results.map(({ tab, presentation: p }, i) => quick
          ? <div key={tab.id} id={`shell-result-${i}`} role="option" aria-selected={index === i} data-testid="shell-quick-option" data-tab-id={tab.id} data-result-index={i}
            className={`min-w-0 rounded p-2 cursor-pointer ${index === i ? "bg-[var(--taomni-selected)]" : ""}`} onClick={() => activate(tab.id)}>
            <strong className="flex gap-2 items-center truncate"><TabIcon tab={tab} />{tab.title}</strong><span className="text-xs opacity-70">{p.preview.summary}</span>
          </div>
          : <article key={tab.id} data-testid="shell-tab-card" data-tab-id={tab.id} data-tab-type={tab.type} data-result-index={i} data-lane={p.lane} data-active={p.active}
            data-attention={p.attention} data-dirty={p.dirty} data-pinned={p.pinned} onContextMenu={(event) => showShellTabMenu(event, tab.id)}
            className={`min-w-0 rounded border p-2 ${index === i ? "border-[var(--taomni-accent)]" : "border-[var(--taomni-divider)]"}`}>
            <button type="button" data-testid="shell-tab-card-open" className="text-left w-full min-w-0" onClick={() => activate(tab.id)} onFocus={() => setIndex(i)}
              onKeyDown={(e) => { if (!e.nativeEvent.isComposing && e.key === "Delete" && tab.closable) { e.preventDefault(); void close(tab.id); } }}>
              <strong data-testid="shell-tab-card-title" className="flex gap-2 items-center truncate"><TabIcon tab={tab} />{tab.title}</strong>
              <span data-testid="shell-tab-card-summary" className="block text-xs truncate opacity-70">{tab.type} · {p.preview.summary}</span>
              <span data-testid="shell-tab-card-preview" className="block text-xs truncate mt-1">{p.preview.secondary || t("shell.noPreview")}</span>
              <span data-testid="shell-tab-card-status" className="block text-xs">{p.dirty ? t("shell.dirty") + " · " : ""}{t(`shell.attentionStates.${p.attention}`)}{p.unreadCount ? ` (${p.unreadCount})` : ""}</span>
            </button>
            <div className="flex justify-end gap-2 mt-2">
              <button data-testid="shell-tab-card-details" aria-label={t("shell.details")} onClick={() => setDetails(details === tab.id ? null : tab.id)}><Info className="w-4 h-4" /></button>
              {tab.closable && <button type="button" data-testid="shell-tab-card-pin" aria-label={t(p.pinned ? "shell.unpin" : "shell.pin")} onClick={() => shell.pinTab(tab.id, !p.pinned)}>{p.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}</button>}
              <button type="button" data-testid="shell-tab-card-more" aria-label={t("shell.more")} onClick={(event) => showShellTabMenu(event, tab.id)}><MoreHorizontal className="w-4 h-4" /></button>
              {tab.closable && <button type="button" data-testid="shell-tab-card-close" aria-label={t("tabs.close")} onClick={() => void close(tab.id)}><X className="w-4 h-4" /></button>}
            </div>
            {details === tab.id && <dl data-testid="shell-tab-card-detail" className="text-xs mt-2 break-all"><dt>{t("shell.type")}</dt><dd>{tab.type}</dd><dt>{t("shell.owner", { name: tab.title })}</dt><dd>{p.preview.summary}</dd><dt>{t("shell.lane")}</dt><dd>{t(`shell.lanes.${p.lane}`)}</dd></dl>}
          </article>)}
        {!results.length && <div data-testid="shell-tab-empty" className="p-4"><p>{t("shell.empty")}</p><div className="flex flex-wrap gap-3 mt-2"><button data-testid="shell-tab-clear" onClick={clear}>{t("shell.clear")}</button><button data-testid="shell-tab-empty-home" onClick={() => activate("welcome")}>{t("shell.home")}</button><button data-testid="shell-tab-empty-new" onClick={() => { shell.setOverlay(null); onNewSession(); }}>{t("shell.newSession")}</button></div></div>}
      </div>
    </div>
  </div>;
}

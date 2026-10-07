import { useT } from "../../lib/i18n";
import { PanelsTopLeft, PanelRight, X } from "lucide-react";
import { WorkspacePreview } from "./WorkspacePreview";
import { TabBar, type TabBarProps } from "../tabbar/TabBar";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { tabToSurfaceDescriptor } from "../../lib/workspaceScope";
import type { WorkspaceView } from "../../types/workspace";
import type { SessionConfig } from "../../lib/ipc";
import type { AppCommand } from "../menubar/commands";
import { addWorkspaceRoot, WorkspaceReferences } from "../sidebar/WorkspaceNavigator";

const views: WorkspaceView[] = ["overview", "files", "terminal", "preview", "tao", "changes", "mail"];
const button = "rounded px-3 py-1.5 hover:bg-[var(--taomni-hover)] disabled:opacity-50";

export function openWorkspaceView(view: WorkspaceView) {
  const state = useWorkspaceStore.getState();
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!workspace) { useWorkspaceStore.setState({ section: "work", canvas: "workspace" }); useAppStore.getState().setSidebarCollapsed(false); return; }
  state.selectView(view);
  if (view === "tao") { void useChatStore.getState().openTabChat(`workspace:${workspace.id}`); return; }
  if (!["files", "changes", "mail"].includes(view)) return;
  if ((view === "files" || view === "changes") && !workspace.roots.length && !workspace.looseFiles.length) return;
  const app = useAppStore.getState();
  const existing = app.tabs.find((tab) => {
    const surface = tabToSurfaceDescriptor(tab);
    return (surface.scope === "workspace" && surface.workspaceId === workspace.id && surface.kind === view)
      || (view === "mail" && surface.scope === "global" && surface.kind === "mail-unified" && surface.contextWorkspaceId === workspace.id);
  });
  if (existing) { app.setActiveTab(existing.id); return; }
  const id = crypto.randomUUID();
  const root = workspace.roots[0]?.path ?? "";
  if (view === "files") app.addTab({ id, type: "code-workspace", title: workspace.name, closable: true,
    surface: { scope: "workspace", kind: "files", surfaceId: id, workspaceId: workspace.id },
    codeWorkspace: { repoRoot: root, roots: workspace.roots, looseFiles: workspace.looseFiles, workspaceId: workspace.id, workspaceInstanceId: workspace.id, name: workspace.name } });
  if (view === "changes") app.addTab({ id, type: "git", title: `${workspace.name} · Changes`, closable: true,
    surface: { scope: "workspace", kind: "changes", surfaceId: id, workspaceId: workspace.id },
    git: { repoRoot: root, sourceWorkspaceId: workspace.id, sourceWorkspaceName: workspace.name } });
  if (view === "mail") app.addTab({ id, type: "mail-unified", title: `${workspace.name} · Mail`, closable: true,
    surface: { scope: "global", kind: "mail-unified", surfaceId: id, contextWorkspaceId: workspace.id } });
}

export function WorkspaceChrome(props: TabBarProps) {
  const t = useT();
  const [detailsReveal, setDetailsReveal] = useState(false);
  const state = useWorkspaceStore();
  const { tabs, activeTabId } = useAppStore();
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const active = tabs.find((tab) => tab.id === activeTabId);
  const descriptor = active && tabToSurfaceDescriptor(active);
  const workspaceContext = state.canvas === "workspace" || descriptor?.scope === "workspace" || (descriptor?.scope === "session" && !!descriptor.workspaceId)
    || (descriptor?.scope === "global" && descriptor.kind === "mail-unified" && !!descriptor.contextWorkspaceId);
  const scopedTabs = tabs.filter((tab) => {
    if (tab.type === "welcome") return false;
    const surface = tabToSurfaceDescriptor(tab);
    if (!workspaceContext) return surface.scope === descriptor?.scope && !("workspaceId" in surface && surface.workspaceId);
    return ("workspaceId" in surface && surface.workspaceId === workspace?.id) || (surface.scope === "global" && surface.kind === "mail-unified" && surface.contextWorkspaceId === workspace?.id);
  });
  return <div data-testid="workspace-chrome" className="shrink-0 min-w-0 border-b border-[var(--taomni-divider)]">
    <div className="flex min-w-0 items-center gap-2 px-3 py-2">
      <strong data-testid="workspace-header" className="truncate">{workspaceContext ? `Workspace · ${workspace?.name ?? "Select or create"}` : `${descriptor?.scope ?? "global"} · ${active?.title ?? "Home"}`}</strong>
      <span data-testid="surface-scope" className="text-xs text-[var(--taomni-text-muted)]">{workspaceContext ? "workspace" : descriptor?.scope}</span>
      {workspaceContext && workspace && <button data-testid="workspace-context-toggle" aria-label={t("workspace.context")} aria-expanded={workspace.navigation.rightPaneOpen} className="ml-auto rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={() => void state.patch(workspace.id, { navigation: { rightPaneOpen: !workspace.navigation.rightPaneOpen } }).catch(() => {})}><PanelRight className="w-4 h-4" /></button>}
    </div>
    <div data-testid="workspace-surface-strip" className="flex min-w-0 overflow-x-auto gap-1 px-2 text-xs" role="tablist" aria-label="Workspace surfaces">
      {workspaceContext && workspace && views.map((view) => <button role="tab" key={view} data-testid={`workspace-surface-${view}`} aria-selected={workspace.navigation.activeSurface === view} className={`${button} capitalize whitespace-nowrap aria-selected:bg-[var(--taomni-selected)]`} onClick={() => openWorkspaceView(view)}>{t(`workspace.${view}`)}</button>)}
    </div>
    <div data-testid="surface-instances" className="flex min-w-0 items-center">
      <div className="flex-1 min-w-0"><TabBar {...props} detailsRevealExternal={detailsReveal} surfaceIds={scopedTabs.map((tab) => tab.id)} /></div>
      <button data-testid="tab-details-hover" aria-label="Surface details" title="Surface details" className="h-6 w-7 shrink-0 flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onMouseEnter={() => setDetailsReveal(true)} onMouseLeave={() => setDetailsReveal(false)} onFocus={() => setDetailsReveal(true)} onBlur={() => setDetailsReveal(false)}><PanelsTopLeft className="w-4 h-4" /></button>
    </div>
  </div>;
}

export function WorkspaceCanvas({ onConnectSession }: { onConnectSession: (session: SessionConfig, workspaceId?: string) => void }) {
  const t = useT();
  const state = useWorkspaceStore();
  const sessions = useSessionStore((s) => s.sessions);
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const [rename, setRename] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const view = workspace?.navigation.activeSurface ?? "overview";
  return <div data-testid="workspace-canvas" className="absolute inset-0 overflow-auto p-5 bg-[var(--taomni-bg)]">
    {state.error && <p role="alert">{state.error}<button className={button} onClick={() => void state.load()}>{t("workspace.retry")}</button></p>}
    {!workspace ? <div className="max-w-xl mx-auto py-10"><h1 className="text-xl font-semibold">Your workspaces</h1><p className="py-4">Organize projects and reference saved sessions without duplicating connections.</p><button data-testid="workspace-empty-create" className={button} onClick={() => useWorkspaceStore.setState({ createDialogOpen: true })}>{t("workspace.create")}</button><button className={button} onClick={() => { useWorkspaceStore.setState({ section: "sessions" }); useAppStore.getState().setSidebarCollapsed(false); }}>Browse sessions</button></div>
      : <div className="max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold">{workspace.name} · <span className="capitalize">{t(`workspace.${view}`)}</span></h1>
        {view === "overview" && <>
          <p className="py-3 text-[var(--taomni-text-muted)]">{workspace.description || `${workspace.roots.length} folders · ${workspace.memberships.length} session references`}</p>
          <div className="flex flex-wrap gap-2">
            <button data-testid="workspace-rename" className={button} onClick={() => setRename(workspace.name)}>{t("workspace.rename")}</button>
            <button data-testid="workspace-add-folder" className={button} onClick={() => void addWorkspaceRoot(workspace).catch((e) => useWorkspaceStore.setState({ error: String(e) }))}>{t("workspace.addFolder")}</button>
            <button data-testid="workspace-delete" className={button} onClick={() => setConfirmDelete(true)}>{t("workspace.delete")}</button>
          </div>
          {rename !== null && <form className="flex gap-2 my-3" onSubmit={(e) => { e.preventDefault(); void state.patch(workspace.id, { name: rename.trim() }).then(() => setRename(null)).catch(() => {}); }}><input aria-label={t("workspace.name")} data-testid="workspace-rename-input" className="taomni-input" value={rename} onChange={(e) => setRename(e.target.value)} /><button disabled={!rename.trim()} className={button}>Save</button><button type="button" className={button} onClick={() => setRename(null)}>Cancel</button></form>}
          {confirmDelete && <div role="alertdialog" aria-label="Delete workspace" className="p-3 border rounded my-3"><p>Delete this workspace and its references? Saved sessions will remain.</p><button data-testid="workspace-delete-confirm" className={button} onClick={() => void state.remove(workspace.id).then(() => setConfirmDelete(false)).catch((e) => useWorkspaceStore.setState({ error: String(e) }))}>Delete</button><button className={button} onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
          <section className="py-4"><h2 className="font-semibold">Folders</h2>{workspace.roots.map((root) => <div className="flex gap-2 items-center py-2" key={root.id}><button className={`${button} truncate`} onClick={() => openWorkspaceView("files")}>{root.path}</button><button className={button} onClick={() => void state.patch(workspace.id, { roots: workspace.roots.filter((r) => r.id !== root.id) }).catch(() => {})}>{t("workspace.removeFolder")}</button></div>)}</section>
        </>}
        {(view === "terminal" || view === "overview" || view === "mail") && <WorkspaceReferences workspace={workspace} sessions={view === "mail" ? sessions.filter((s) => s.session_type === "Mail") : sessions} onConnectSession={onConnectSession} />}
        {(view === "files" || view === "changes") && <div className="py-4"><p>Add a project folder to open {view}.</p><button className={button} onClick={() => void addWorkspaceRoot(workspace).then(() => openWorkspaceView(view)).catch((e) => useWorkspaceStore.setState({ error: String(e) }))}>Choose folder</button></div>}
        {view === "preview" && <WorkspacePreview key={workspace.id} workspace={workspace} />}
        {view === "tao" && <button className={`${button} my-4`} onClick={() => void useChatStore.getState().openTabChat(`workspace:${workspace.id}`)}>Open workspace Tao</button>}
      </div>}
  </div>;
}

export function WorkspaceContextPane({ onConnectSession }: { onConnectSession: (session: SessionConfig, workspaceId?: string) => void }) {
  const t = useT();
  const state = useWorkspaceStore();
  const sessions = useSessionStore((s) => s.sessions);
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tab = useAppStore((s) => s.tabs.find((candidate) => candidate.id === s.activeTabId));
  const surface = tab && tabToSurfaceDescriptor(tab);
  const inWorkspace = state.canvas === "workspace" || (surface && "workspaceId" in surface && surface.workspaceId === workspace?.id)
    || (surface?.scope === "global" && surface.kind === "mail-unified" && surface.contextWorkspaceId === workspace?.id);
  if (!workspace?.navigation.rightPaneOpen || !inWorkspace) return null;
  return <aside data-testid="workspace-context-pane" aria-label={t("workspace.context")} className="absolute right-0 top-0 bottom-0 z-20 w-72 max-w-full overflow-auto border-l border-[var(--taomni-divider)] bg-[var(--taomni-bg)] shadow-lg p-3">
    <div className="flex items-center gap-2 mb-3"><strong className="truncate flex-1">{workspace.name}</strong><button data-testid="workspace-context-close" aria-label={t("workspace.closeContext")} className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={() => { void state.patch(workspace.id, { navigation: { rightPaneOpen: false } }).catch(() => {}); document.querySelector<HTMLButtonElement>('[data-testid="workspace-context-toggle"]')?.focus(); }}><X className="w-4 h-4" /></button></div>
    <p className="text-xs text-[var(--taomni-text-muted)] mb-3">Workspace · {workspace.navigation.activeSurface}</p>
    {workspace.roots.map((root) => <div key={root.id} className="truncate py-1" title={root.path}>{root.name}</div>)}
    <WorkspaceReferences workspace={workspace} sessions={sessions} onConnectSession={onConnectSession} />
  </aside>;
}

export function WorkspaceDialogs({ onCommand, onConnectSession }: { onCommand: (command: AppCommand) => void; onConnectSession: (session: SessionConfig) => void }) {
  const t = useT();
  const state = useWorkspaceStore();
  const sessions = useSessionStore((s) => s.sessions);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = state.createDialogOpen || state.commandCenterOpen;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); event.stopImmediatePropagation(); useWorkspaceStore.setState({ commandCenterOpen: true });
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  useEffect(() => {
    if (open) { previousFocus.current = document.activeElement as HTMLElement; input.current?.focus(); }
    else previousFocus.current?.focus();
  }, [open]);
  if (!open) return null;
  const close = () => { useWorkspaceStore.setState({ createDialogOpen: false, commandCenterOpen: false }); setError(""); };
  const match = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  return <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-black/40" onClick={close} onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
    <div role="dialog" aria-modal="true" aria-label={state.createDialogOpen ? t("workspace.newWorkspace") : t("workspace.commandCenter")} data-testid={state.createDialogOpen ? "workspace-create-dialog" : "command-center"} className="w-[560px] max-w-[calc(100vw-24px)] max-h-[75vh] overflow-auto rounded-lg p-4 shadow-xl bg-[var(--taomni-bg)]" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      {state.createDialogOpen ? <form onSubmit={(e) => { e.preventDefault(); setBusy(true); void state.create(name).then(() => { setName(""); close(); }).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>
        <h2 className="font-semibold mb-3">{t("workspace.newWorkspace")}</h2><input ref={input} data-testid="workspace-name-input" aria-label={t("workspace.name")} className="taomni-input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workspace.name")} />
        {error && <p role="alert">{error}</p>}<div className="flex gap-2 mt-3"><button data-testid="workspace-create-submit" disabled={busy || !name.trim()} className={button}>{t("workspace.create")}</button><button type="button" className={button} onClick={() => { close(); onCommand("new-session"); }}>{t("workspace.newSessionInstead")}</button><button type="button" className={button} onClick={close}>Cancel</button></div>
      </form> : <>
        <input ref={input} data-testid="command-center-search" aria-label="Search commands, workspaces and sessions" className="taomni-input w-full mb-3" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("workspace.commandsPlaceholder")} />
        {state.workspaces.filter((w) => match(w.name)).map((w) => <button key={w.id} className={`${button} block w-full text-left`} onClick={() => { state.selectWorkspace(w.id); close(); }}>Workspace · {w.name}</button>)}
        {sessions.filter((s) => match(s.name)).map((s) => <button key={s.id} className={`${button} block w-full text-left`} onClick={() => { close(); onConnectSession(s); }}>Session · {s.name}</button>)}
        {views.filter(match).map((view) => <button key={view} className={`${button} block w-full text-left capitalize`} onClick={() => { close(); openWorkspaceView(view); }}>Surface · {view}</button>)}
        {(["servers", "tools", "mfa", "lan-chat", "settings", "new-session"] as AppCommand[]).filter(match).map((command) => <button key={command} className={`${button} block w-full text-left`} onClick={() => { close(); onCommand(command); }}>Global · {command}</button>)}
        <button className={button} onClick={close}>Close</button>
      </>}
    </div>
  </div>;
}

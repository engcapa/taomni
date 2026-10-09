import { useT } from "../../lib/i18n";
import { Pin, PinOff } from "lucide-react";
import { useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSessionStore } from "../../stores/sessionStore";
import { recentWorkspaceIdFromParts, useAppStore } from "../../stores/appStore";
import { selectFolderPath, type SessionConfig } from "../../lib/ipc";
import type { Workspace } from "../../types/workspace";

const buttonClass = "px-2 py-1 rounded hover:bg-[var(--taomni-hover)] text-left";
export function WorkspaceNavigator({ onConnectSession }: { onConnectSession?: (session: SessionConfig, workspaceId?: string) => void }) {
  const t = useT();
  const state = useWorkspaceStore();
  const sessions = useSessionStore((s) => s.sessions);
  const recents = useAppStore((s) => s.recentWorkspaces);
  const [query, setQuery] = useState("");
  const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  return <div data-testid="workspace-navigator" className="flex flex-col min-h-0 flex-1 text-xs">
    <div className="flex items-center p-2 gap-2"><strong className="flex-1">{t("workspace.workspaces")}</strong>
      <button data-testid="workspace-create" className={buttonClass} onClick={() => useWorkspaceStore.setState({ createDialogOpen: true })}>{t("workspace.new")}</button>
      <button data-testid="workspace-hide" className={buttonClass} onClick={() => useAppStore.getState().setSidebarCollapsed(true)}>{t("workspace.hide")}</button>
    </div>
    <input data-testid="workspace-search" aria-label={t("workspace.searchWorkspaces")} className="taomni-input m-2 min-w-0" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("workspace.searchWorkspaces")} />
    {state.error && <div role="alert" className="p-2">{state.error}<button onClick={() => void state.load()}>{t("workspace.retry")}</button></div>}
    <div className="flex-1 overflow-auto p-2">
      {([true, false] as const).map((pinned) => <section key={String(pinned)}>
        <h3 className="text-[var(--taomni-text-muted)] py-2">{pinned ? t("workspace.pinned") : t("workspace.recent")}</h3>
        {state.workspaces.filter((w) => w.pinned === pinned && `${w.name} ${w.description} ${w.roots.map((r) => r.path).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).map((w) => <div key={w.id} className="flex min-w-0">
            <button data-testid={`workspace-row-${w.id}`} aria-current={w.id === active?.id ? "page" : undefined} className={`${buttonClass} flex-1 truncate aria-[current=page]:bg-[var(--taomni-selected)]`} onClick={() => state.selectWorkspace(w.id)}>{w.name}</button>
            <button aria-label={w.pinned ? `Unpin ${w.name}` : `Pin ${w.name}`} className={buttonClass} onClick={() => void state.patch(w.id, { pinned: !w.pinned }).catch(() => {})}>{w.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}</button>
          </div>)}
      </section>)}
      {!state.workspaces.length && <p className="p-2 text-[var(--taomni-text-muted)]">{t("workspace.empty")}</p>}
      {recents.filter((r) => !state.workspaces.some((w) => w.legacyRecentId === r.id
        || recentWorkspaceIdFromParts(w.roots, w.looseFiles) === r.id)).map((r) => <button key={r.id} className={`${buttonClass} block w-full truncate`} onClick={() => void state.create(r.name, r).catch((error) => useWorkspaceStore.setState({ error: String(error) }))}>Import {r.name}</button>)}
      {active && <WorkspaceReferences workspace={active} sessions={sessions} onConnectSession={onConnectSession} />}
    </div>
  </div>;
}

export function WorkspaceReferences({ workspace, sessions, onConnectSession }: { workspace: Workspace; sessions: SessionConfig[]; onConnectSession?: (session: SessionConfig, workspaceId?: string) => void }) {
  const t = useT();
  const store = useWorkspaceStore();
  return <section data-testid="workspace-references" className="mt-4">
    <h3 className="font-semibold py-2">{t("workspace.references")}</h3>
    {workspace.memberships.map((member) => {
      const session = sessions.find((s) => s.id === member.sessionId);
      return <div key={member.sessionId} data-testid={`workspace-reference-${member.sessionId}`} className="py-2 border-b border-[var(--taomni-divider)]">
        <button data-testid="workspace-open-reference" data-session-name={session?.name} className={buttonClass} disabled={!session} onClick={() => session && onConnectSession?.(session, workspace.id)}>{session?.name ?? `${member.sessionId} · unavailable`}</button>
        <select aria-label={`Role for ${session?.name ?? member.sessionId}`} className="taomni-input max-w-full" value={member.role} onChange={(e) => void store.patchMembership(workspace.id, member.sessionId, { role: e.target.value as typeof member.role }).catch(() => {})}>
          <option value="primary">{t("workspace.primary")}</option><option value="attached">{t("workspace.attached")}</option><option value="reference">{t("workspace.reference")}</option>
        </select>
        <div className="flex flex-wrap gap-1">
          <button className={buttonClass} onClick={() => { useWorkspaceStore.setState({ section: "sessions" }); useSessionStore.getState().setSelectedSession(member.sessionId); useSessionStore.getState().setSearchQuery(session?.name ?? member.sessionId); }}>{t("workspace.revealSession")}</button>
          {!session && <button className={buttonClass} onClick={() => void useSessionStore.getState().loadSessions()}>{t("workspace.retry")}</button>}
          <button className={buttonClass} onClick={() => void store.removeMembership(workspace.id, member.sessionId).catch(() => {})}>{t("workspace.removeReference")}</button>
        </div>
      </div>;
    })}
    {!workspace.memberships.some((m) => m.role === "primary") && <p className="text-[var(--taomni-text-muted)] py-2">{t("workspace.noPrimary")}</p>}
    <label className="block py-2">{t("workspace.addSession")}
      <select data-testid="workspace-add-session" className="taomni-input w-full" value="" onChange={(e) => { if (e.target.value) void store.addMembership(workspace.id, e.target.value).catch(() => {}); }}>
        <option value="">{t("workspace.selectSession")}</option>
        {sessions.filter((s) => !workspace.memberships.some((m) => m.sessionId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  </section>;
}

export async function addWorkspaceRoot(workspace: Workspace) {
  const path = await selectFolderPath();
  if (!path || workspace.roots.some((r) => r.path === path)) return;
  await useWorkspaceStore.getState().patch(workspace.id, { roots: [...workspace.roots, { id: crypto.randomUUID(), path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, kind: "folder" }] });
}

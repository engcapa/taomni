import { useMemo, useState } from "react";
import {
  FilePlus2,
  FolderPlus,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { TextInputDialog } from "../sidebar/ConfirmDialog";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";
import type { AppCommand } from "../menubar/commands";
import { useSessionStore } from "../../stores/sessionStore";
import { getHomeDir } from "../../lib/ipc";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

type FsModal =
  | { kind: "new-file" }
  | { kind: "new-folder" }
  | { kind: "add-folder" }
  | { kind: "new-workspace" }
  | null;

interface WorkspaceSidebarProps {
  onCommand?: (command: AppCommand) => void;
  /** Open a global session as an isolated workspace tab (layout resolves auth). */
  onOpenWorkspaceSession?: (session: SessionConfig) => void;
}

/**
 * Workspaces-mode sidebar (v6.1 TASK-05): workspace switcher on top, quick
 * create toolbar (new file / new folder / add folder — Multi-Root), lens
 * content (project roots / sessions / structure) and the persistent Git bar.
 */
export function WorkspaceSidebar({ onOpenWorkspaceSession }: WorkspaceSidebarProps) {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  const [modal, setModal] = useState<FsModal>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!workspace) return null;
  const lens = workspace.activeLeftToolWindow;
  const openAddFolder = () => setModal({ kind: "add-folder" });

  return (
    <div data-testid="workspace-sidebar" className="relative flex min-h-0 flex-1 flex-col" style={{ background: "var(--taomni-sidebar-bg)" }}>
      <WorkspaceSwitcher onAddFolder={openAddFolder} onCreateWorkspace={() => setModal({ kind: "new-workspace" })} />
      <div className="flex h-7 shrink-0 items-center gap-1 border-b px-1.5" style={{ borderColor: "var(--taomni-divider)" }}>
        <IconBtn
          testId="workspace-new-file"
          title={`${t("workspace.newFile")} (Alt+Insert)`}
          icon={<FilePlus2 className="h-3.5 w-3.5" />}
          disabled={workspace.rootFolders.length === 0}
          onClick={() => setModal({ kind: "new-file" })}
        />
        <IconBtn
          testId="workspace-new-folder"
          title={t("workspace.newFolder")}
          icon={<FolderPlus className="h-3.5 w-3.5" />}
          disabled={workspace.rootFolders.length === 0}
          onClick={() => setModal({ kind: "new-folder" })}
        />
        <IconBtn
          testId="workspace-add-folder"
          title={t("workspace.addFolder")}
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={openAddFolder}
        />
        <span className="taomni-divider-v mx-1 h-4" />
        <IconBtn
          testId="workspace-refresh"
          title={t("workspace.refreshRoots")}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => setNotice(t("workspace.refreshRoots"))}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {lens === "project" ? (
          <ProjectLens workspaceId={workspace.id} roots={workspace.rootFolders} onAddFolder={openAddFolder} />
        ) : lens === "sessions" ? (
          <WorkspaceSessionsLens workspaceId={workspace.id} pinnedSessionIds={workspace.pinnedSessionIds} onOpenSession={onOpenWorkspaceSession} />
        ) : (
          <StructureLens />
        )}
      </div>

      <WorkspaceGitBar workspaceId={workspace.id} roots={workspace.rootFolders} />

      {modal?.kind === "new-file" && (
        <TextInputDialog
          title={t("workspace.newFile")}
          label={t("workspace.newFile")}
          placeholder="src/main.ts"
          onCancel={() => setModal(null)}
          onConfirm={(value) => {
            setModal(null);
            const rootId = workspace.rootFolders[0]?.id;
            const relative = value.trim();
            if (!rootId || !relative) return;
            void useWorkspacePlatformStore.getState()
              .createFileInWorkspace(workspace.id, rootId, relative)
              .then((tab) => setNotice(tab ? `${t("workspace.newFile")}: ${tab.title}` : t("workspace.noRoots")));
          }}
        />
      )}
      {modal?.kind === "new-folder" && (
        <TextInputDialog
          title={t("workspace.newFolder")}
          label={t("workspace.newFolder")}
          placeholder="src/utils"
          onCancel={() => setModal(null)}
          onConfirm={(value) => {
            setModal(null);
            const rootId = workspace.rootFolders[0]?.id;
            const relative = value.trim();
            if (!rootId || !relative) return;
            void useWorkspacePlatformStore.getState()
              .createFolderInWorkspace(workspace.id, rootId, relative)
              .then(() => setNotice(`${t("workspace.newFolder")}: ${relative}`));
          }}
        />
      )}
      {modal?.kind === "add-folder" && (
        <TextInputDialog
          title={t("workspace.addFolderTitle")}
          label={t("workspace.addFolderPathLabel")}
          placeholder="~/project"
          onCancel={() => setModal(null)}
          onConfirm={(value) => {
            const typed = value.trim();
            if (!typed) return;
            void resolveWorkspaceFolderPath(typed).then((path) => {
              useWorkspacePlatformStore.getState().addRootFolder(workspace.id, { path });
              setModal(null);
              setNotice(`${t("workspace.addFolderTitle")}: ${path}`);
            });
          }}
        />
      )}
      {modal?.kind === "new-workspace" && (
        <TextInputDialog
          title={t("workspace.newWorkspace")}
          label={t("workspace.newWorkspace")}
          placeholder="My workspace"
          onCancel={() => setModal(null)}
          onConfirm={(value) => {
            setModal(null);
            useWorkspacePlatformStore.getState().createWorkspace(value.trim() || "Workspace");
          }}
        />
      )}
      {notice && (
        <div
          data-testid="workspace-sidebar-notice"
          role="status"
          className="absolute bottom-10 left-2 z-40 rounded px-2 py-1 text-[11px] shadow"
          style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}
          onClick={() => setNotice(null)}
        >
          {notice}
        </div>
      )}
    </div>
  );
}

/** Expand a leading `~` to the OS home directory (browser preview: VFS root). */
async function resolveWorkspaceFolderPath(typed: string): Promise<string> {
  if (typed !== "~" && !typed.startsWith("~/") && !typed.startsWith("~\\")) return typed;
  const home = await getHomeDir().catch(() => null);
  if (!home) return typed;
  const expanded = typed.replace(/^~[\/]?/, `${home.replace(/[\/]+$/, "")}/`);
  return expanded.replace(/\/+$/, "");
}

function ProjectLens({ workspaceId, roots, onAddFolder }: { workspaceId: string; roots: { id: string; name: string; path: string }[]; onAddFolder: () => void }) {
  const t = useT();
  const removeRootFolder = useWorkspacePlatformStore((s) => s.removeRootFolder);
  return (
    <div data-testid="workspace-project-lens" className="p-1.5">
      <div className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
        {t("workspace.rootsTitle")} ({roots.length})
      </div>
      {roots.length === 0 ? (
        <button
          type="button"
          data-testid="workspace-empty-add-folder"
          className="flex w-full items-center gap-2 rounded border border-dashed px-2 py-3 text-[12px] hover:bg-[var(--taomni-hover)]"
          style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
          onClick={onAddFolder}
        >
          <FolderOpen className="h-4 w-4" />
          {t("workspace.noRoots")}
        </button>
      ) : (
        roots.map((root) => (
          <div
            key={root.id}
            data-testid="workspace-root-folder"
            data-root-id={root.id}
            className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--taomni-hover)]"
            title={root.path}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px]" style={{ color: "var(--taomni-text)" }}>{root.name}</div>
              <div className="truncate text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>{root.path}</div>
            </div>
            <button
              type="button"
              data-testid={`workspace-remove-root-${root.id}`}
              title={t("workspace.removeRoot")}
              className="shrink-0 rounded p-0.5 opacity-0 hover:bg-[var(--taomni-hover)] group-hover:opacity-100"
              style={{ color: "var(--taomni-text-muted)" }}
              onClick={() => removeRootFolder(workspaceId, root.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function StructureLens() {
  const t = useT();
  return (
    <div data-testid="workspace-structure-lens" className="p-2 text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
      {t("sidebar.workspaceToolStructure")}
    </div>
  );
}

function WorkspaceGitBar({ workspaceId, roots }: { workspaceId: string; roots: { id: string; name: string }[] }) {
  const t = useT();
  const openGitPanel = useWorkspacePlatformStore((s) => s.openGitPanel);
  const repoName = roots[0]?.name ?? t("workspace.gitBarNoRepo");
  return (
    <button
      type="button"
      data-testid="workspace-sidebar-git-bar"
      title={t("workspace.gitBarOpen")}
      className="flex h-7 shrink-0 items-center gap-2 border-t px-2 text-[11px]"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text)" }}
      onClick={() => openGitPanel(workspaceId)}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left font-medium">{repoName}</span>
      <span className="shrink-0" style={{ color: "var(--taomni-accent)" }}>{t("workspace.gitBarOpen")} →</span>
    </button>
  );
}

/** Sessions lens: pinned workspace favorites on top, full global list below. */
function WorkspaceSessionsLens({
  workspaceId,
  pinnedSessionIds,
  onOpenSession,
}: {
  workspaceId: string;
  pinnedSessionIds: string[];
  onOpenSession?: (session: SessionConfig) => void;
}) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const pinned = pinnedSessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionConfig => !!session);
  return (
    <div data-testid="workspace-sessions-lens" className="flex min-h-0 flex-col p-1.5">
      <div className="px-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
        ★ {t("workspace.pinnedSessions")} ({pinned.length})
      </div>
      {pinned.length === 0 ? (
        <div className="px-2 py-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("workspace.pickerEmpty")}
        </div>
      ) : (
        pinned.map((session) => (
          <PinnedSessionRow key={session.id} workspaceId={workspaceId} session={session} onOpenSession={onOpenSession} />
        ))
      )}
      <div className="mt-2 px-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
        {t("workspace.allSessions")}
      </div>
      <GlobalSessionsList onOpenSession={onOpenSession} excludeIds={pinnedSessionIds} />
    </div>
  );
}

function PinnedSessionRow({
  workspaceId,
  session,
  onOpenSession,
}: {
  workspaceId: string;
  session: SessionConfig;
  onOpenSession?: (session: SessionConfig) => void;
}) {
  const togglePinSession = useWorkspacePlatformStore((s) => s.togglePinSession);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-testid="workspace-pinned-session"
        data-session-id={session.id}
        data-session-name={session.name || session.host || ""}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
        style={{ color: "var(--taomni-text)" }}
        onClick={() => onOpenSession?.(session)}
        title={session.name || session.host || session.id}
      >
        <Star className="h-3 w-3 shrink-0" style={{ color: "var(--taomni-accent)" }} />
        <span className="min-w-0 flex-1 truncate">{session.name || session.host}</span>
      </button>
      <button
        type="button"
        data-testid={`workspace-unpin-${session.id}`}
        title="Unpin"
        className="shrink-0 rounded p-0.5 hover:bg-[var(--taomni-hover)]"
        style={{ color: "var(--taomni-text-muted)" }}
        onClick={() => togglePinSession(workspaceId, session.id)}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function GlobalSessionsList({ onOpenSession, excludeIds }: { onOpenSession?: (session: SessionConfig) => void; excludeIds: string[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const sessions = useSessionStore((s) => s.sessions);
  const filtered = useMemo(
    () => sessions.filter((session) => {
      if (excludeIds.includes(session.id)) return false;
      if (!query.trim()) return true;
      const needle = query.trim().toLowerCase();
      return (session.name || "").toLowerCase().includes(needle)
        || (session.host || "").toLowerCase().includes(needle)
        || session.session_type.toLowerCase().includes(needle);
    }),
    [sessions, query, excludeIds],
  );
  return (
    <>
      <div className="relative my-1">
        <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: "var(--taomni-text-muted)" }} />
        <input
          type="search"
          data-testid="workspace-sessions-search"
          aria-label={t("workspace.pickerSearch")}
          className="taomni-input w-full"
          style={{ paddingLeft: "22px" }}
          placeholder={t("workspace.pickerSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 overflow-y-auto">
        {filtered.map((session) => (
          <button
            key={session.id}
            type="button"
            data-testid="workspace-global-session"
            data-session-id={session.id}
            data-session-name={session.name || session.host || ""}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
            style={{ color: "var(--taomni-text)" }}
            onClick={() => onOpenSession?.(session)}
            title={session.name || session.host || session.id}
          >
            <span
              className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase"
              style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
            >
              {session.session_type}
            </span>
            <span className="min-w-0 flex-1 truncate">{session.name || session.host}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("workspace.pickerEmpty")}</div>
        )}
      </div>
    </>
  );
}

function IconBtn({
  icon,
  title,
  testId,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      type="button"
    >
      {icon}
    </button>
  );
}

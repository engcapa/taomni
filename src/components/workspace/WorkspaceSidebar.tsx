import { GitBranch, ChevronDown, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { gitProbePath, gitSnapshot } from "../../lib/git";
import { useAppStore } from "../../stores/appStore";
import {
  useWorkspacePlatformStore,
  type PlatformWorkspace,
} from "../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { WorkspaceSessionsPanel } from "./WorkspaceSessionsPanel";
import { useSessionStore } from "../../stores/sessionStore";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useWorkspaceEditorHostStore } from "../../stores/workspaceEditorHostStore";

export interface WorkspaceSidebarProps {
  onOpenSessionPicker: () => void;
}

interface GitBarState {
  branch: string | null;
  changeCount: number;
}

function useWorkspaceGitBar(workspace: PlatformWorkspace | undefined): GitBarState {
  const [state, setState] = useState<GitBarState>({ branch: null, changeCount: 0 });
  const rootsKey = workspace?.rootFolders.map((root) => root.path).join("|") ?? "";
  useEffect(() => {
    let cancelled = false;
    const first = workspace?.rootFolders[0];
    if (!first) {
      setState({ branch: null, changeCount: 0 });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const probe = await gitProbePath(first.path);
        if (cancelled) return;
        if (!probe?.isRepo || !probe.repoRoot) {
          setState({ branch: null, changeCount: 0 });
          return;
        }
        const snapshot = await gitSnapshot(probe.repoRoot);
        if (cancelled) return;
        setState({
          branch: snapshot?.currentBranch ?? null,
          changeCount: snapshot?.changes?.length ?? 0,
        });
      } catch {
        if (!cancelled) setState({ branch: null, changeCount: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootsKey, workspace?.rootFolders]);
  return state;
}

/**
 * Workspaces mode left sidebar (AC-05/06/08): workspace switcher, the active
 * tool window (multi-root project tree / workspace sessions / structure), and
 * the permanent Git status bar. The removed `[Files | Git]` row is deliberately
 * absent; Git is reached from the rail, this bar, or the editor toolbar.
 */
export function WorkspaceSidebar({ onOpenSessionPicker }: WorkspaceSidebarProps) {
  const t = useT();
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === s.activeWorkspaceId));
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const store = useWorkspacePlatformStore.getState;
  const openFsModal = useWorkspaceUiStore((s) => s.openFsModal);
  const [linkedOpenByWorkspace, setLinkedOpenByWorkspace] = useState<Record<string, boolean>>({});
  const setHost = useWorkspaceEditorHostStore((state) => state.setHost);
  const workspaceId = workspace?.id;
  const editorHostRef = useCallback((element: HTMLDivElement | null) => {
    if (workspaceId) setHost(workspaceId, element);
  }, [setHost, workspaceId]);
  const sessions = useSessionStore((s) => s.sessions);
  const gitBar = useWorkspaceGitBar(workspace);

  const lens = workspace?.activeLeftToolWindow ?? "project";
  if (!workspace) return null;
  const linkedOpen = linkedOpenByWorkspace[workspace.id] ?? workspace.openTabs.some((tab) => tab.kind === "file");

  return (
    <div data-testid="workspace-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
      <WorkspaceSwitcher onAddFolder={() => openFsModal({ kind: "root", directory: "" })} />
      <div ref={editorHostRef} data-testid="workspace-editor-tool-host"
        className="min-h-0 flex-1 overflow-hidden" style={{ display: lens === "sessions" ? "none" : undefined }} />
      {lens === "project" && (
        <>
        <section data-testid="workspace-linked-sessions" className="shrink-0 border-t p-1.5" style={{ borderColor: "var(--taomni-chrome-border)" }}>
          <div className="flex items-center justify-between gap-1 text-[10.5px] text-[var(--taomni-text-muted)]">
            <button type="button" data-testid="workspace-linked-sessions-toggle" aria-expanded={linkedOpen} className="inline-flex min-w-0 items-center gap-1 py-1 font-semibold" onClick={() => setLinkedOpenByWorkspace((current) => ({ ...current, [workspace.id]: !linkedOpen }))}><ChevronDown className={`h-3 w-3 ${linkedOpen ? "" : "-rotate-90"}`} />{t("platform.frequentSessions")} ({workspace.pinnedSessionIds.length})</button>
            <button type="button" data-testid="workspace-link-session" className="inline-flex shrink-0 items-center gap-0.5 rounded p-1 hover:bg-[var(--taomni-hover)]" title={t("platform.openAnySession")} onClick={onOpenSessionPicker}><Plus className="h-3 w-3" /></button>
          </div>
          {linkedOpen && <div className="max-h-[180px] overflow-auto">
            <p className="px-1 pb-1 text-[10.5px] text-[var(--taomni-text-muted)]">{t("platform.isolatedSessionHint")}</p>
            {sessions.filter((session) => workspace.pinnedSessionIds.includes(session.id)).map((session) => (
              <button key={session.id} type="button" data-testid="workspace-linked-session" data-session-id={session.id} className="flex h-[24px] w-full items-center gap-1.5 rounded px-1 text-left text-[11.5px] hover:bg-[var(--taomni-hover)]" onClick={() => store().openSessionInWorkspace(workspace.id, session)}><span className="rounded bg-[var(--taomni-selected)] px-1 text-[9px] font-bold text-[var(--taomni-accent)]">{session.session_type.slice(0, 4).toUpperCase()}</span><span className="min-w-0 flex-1 truncate">{session.name}</span><span className="max-w-[90px] truncate font-mono text-[9px] text-[var(--taomni-text-muted)]">{session.host}</span></button>
            ))}
          </div>}
        </section>
        </>
      )}
      {lens === "sessions" && (
        <WorkspaceSessionsPanel
          workspace={workspace}
          onOpenSessionPicker={onOpenSessionPicker}
          onOpenSession={(session) => {
            store().openSessionInWorkspace(workspace.id, session);
            setActiveSideTab("workspaces");
            setSidebarCollapsed(false);
          }}
        />
      )}
      <button
        type="button"
        data-testid="workspace-sidebar-git-bar"
        data-branch={gitBar.branch ?? ""}
        data-changes={gitBar.changeCount}
        className="mt-auto flex h-7 w-full shrink-0 items-center justify-between gap-1 border-t px-2 text-left hover:bg-[var(--taomni-hover)]"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-card-bg)" }}
        title={t("platform.openGitPanel")}
        onClick={() => {
          store().openGitTab(workspace.id);
          setActiveSideTab("workspaces");
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-1 text-[10.5px]">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{gitBar.branch ?? t("platform.noChanges")}</span>
          {gitBar.changeCount > 0 && (
            <span className="shrink-0 rounded px-1 text-[9.5px]" style={{ background: "var(--taomni-selected)", color: "var(--taomni-accent)" }}>
              {gitBar.changeCount}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-accent)" }}>→</span>
      </button>
    </div>
  );
}

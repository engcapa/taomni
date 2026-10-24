import { useCallback, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import type { SessionConfig } from "../../lib/ipc";
import { buildWorkspaceSessionLaunch } from "./workspaceSessionLaunch";

export interface UsePlatformShellContext {
  onOpenGlobalSession?: (session: SessionConfig) => void;
}

/**
 * Workspace-first platform shell glue (v6.1): workspace session launches and
 * the global shortcuts (Ctrl+B sidebar, Ctrl+K command palette, Ctrl+Alt+O
 * workspace session picker, Alt+Insert new workspace file).
 */
export function usePlatformShell(context: UsePlatformShellContext) {
  const { onOpenGlobalSession } = context;

  const openWorkspaceSession = useCallback((session: SessionConfig, options?: { pinToWorkspace?: boolean }) => {
    const workspaceId = useWorkspacePlatformStore.getState().activeWorkspaceId;
    const launch = buildWorkspaceSessionLaunch(session);
    useWorkspacePlatformStore.getState().openSessionInWorkspace(workspaceId, launch, options);
    void useSessionStore.getState().markConnected(session.id);
  }, []);

  // The workspace tab strip and picker stay decoupled from the connection
  // machinery; they request launches through a DOM event.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail ?? {};
      const session = useSessionStore.getState().sessions.find((entry) => entry.id === detail.sessionId);
      if (session) openWorkspaceSession(session);
    };
    window.addEventListener("taomni:workspace-open-session", handler);
    return () => window.removeEventListener("taomni:workspace-open-session", handler);
  }, [openWorkspaceSession]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      const app = useAppStore.getState();
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        app.toggleSidebar();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        app.toggleGlobalSearch();
        return;
      }
      if (mod && event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        useWorkspacePlatformStore.getState().setSessionPickerOpen(true);
        return;
      }
      if (event.altKey && event.key === "Insert" && app.activeSideTab === "workspaces") {
        const button = document.querySelector<HTMLElement>('[data-testid="workspace-new-file"]:not([disabled])');
        if (button) {
          event.preventDefault();
          button.click();
        }
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        useAppStore.getState().setActiveSideTab("workspaces");
        useWorkspacePlatformStore.getState().openGitPanel(useWorkspacePlatformStore.getState().activeWorkspaceId);
        return;
      }
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, []);

  return { openWorkspaceSession, onOpenGlobalSession };
}

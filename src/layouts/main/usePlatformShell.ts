import { useCallback, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import type { SessionConfig } from "../../lib/ipc";
import { t } from "../../lib/i18n";
import { buildWorkspaceSessionLaunch } from "./workspaceSessionLaunch";

export interface UsePlatformShellContext {
  /**
   * Retained for callers that coordinate the global connect flow; the workspace
   * launch path resolves its own payloads.
   */
  onOpenGlobalSession?: (session: SessionConfig) => void;
}

/**
 * True while the event originates in an editor, terminal or text field. Those
 * surfaces own their own chords (Go to Declaration, tmux prefix, Generate,
 * Optimize Imports); window-level platform shortcuts must not shadow them
 * (v6.1 review H9).
 */
function isOwnedKeyTarget(target: EventTarget | null, includeInputs = true): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  if (element.closest(".cm-editor, .xterm")) return true;
  if (!includeInputs) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element.closest("[contenteditable='true']") !== null;
}

/**
 * Workspace-first platform shell glue (v6.1): workspace session launches and
 * the global shortcuts (Ctrl+B sidebar, Ctrl+K command palette, Ctrl+Alt+O
 * workspace session picker, Alt+Insert new workspace file).
 */
export function usePlatformShell(context: UsePlatformShellContext) {
  const { onOpenGlobalSession } = context;

  const openWorkspaceSession = useCallback((session: SessionConfig, options?: { pinToWorkspace?: boolean }) => {
    const launch = buildWorkspaceSessionLaunch(session);
    if (launch.unsupported) {
      useAppStore.getState().setStatusMessage(
        t("workspace.openUnsupported", { type: launch.unsupported }),
      );
      return null;
    }
    const workspaceId = useWorkspacePlatformStore.getState().activeWorkspaceId;
    const tab = useWorkspacePlatformStore.getState().openSessionInWorkspace(workspaceId, launch, options);
    // Opening a workspace tab from Home/Sessions/Agents must reveal the
    // workspace canvas, otherwise the action looks like a no-op (review M7).
    useAppStore.getState().setActiveSideTab("workspaces");
    void useSessionStore.getState().markConnected(session.id).catch(() => undefined);
    return tab;
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
        if (isOwnedKeyTarget(event.target)) return;
        event.preventDefault();
        app.toggleSidebar();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        // Terminals use Ctrl+K for readline kill-line; editors and text
        // fields may legitimately forward it to the palette.
        if (isOwnedKeyTarget(event.target, false)) return;
        event.preventDefault();
        app.toggleGlobalSearch();
        return;
      }
      if (mod && event.altKey && event.key.toLowerCase() === "o") {
        if (isOwnedKeyTarget(event.target)) return;
        event.preventDefault();
        useWorkspacePlatformStore.getState().setSessionPickerOpen(true);
        return;
      }
      if (event.altKey && event.key === "Insert") {
        if (isOwnedKeyTarget(event.target)) return;
        event.preventDefault();
        app.setActiveSideTab("workspaces");
        useWorkspacePlatformStore.getState().requestNewFile();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "g") {
        if (isOwnedKeyTarget(event.target)) return;
        event.preventDefault();
        useAppStore.getState().setActiveSideTab("workspaces");
        useWorkspacePlatformStore.getState().openGitPanel(useWorkspacePlatformStore.getState().activeWorkspaceId);
      }
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, []);

  return { openWorkspaceSession, onOpenGlobalSession };
}

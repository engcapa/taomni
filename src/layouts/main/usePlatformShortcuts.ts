import { useEffect } from "react";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { getAppPlatform } from "../../lib/runtime";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";

const IS_MAC = getAppPlatform() === "macos";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Shell-level shortcuts of the workspace-first UI (v6.1 DEC-01/02/07).
 *
 * `Ctrl/Cmd+B` toggles the left rail, `Ctrl/Cmd+K` opens the command palette,
 * `Ctrl/Cmd+Alt+O` opens the workspace session picker and `Alt+Insert` creates
 * a workspace file. Editor/terminal shortcuts stay owned by their surfaces; the
 * capture phase only claims these chords.
 */
export function usePlatformShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const state = useAppStore.getState();
      const inWorkspace = state.activeSideTab === "workspaces";

      if (mod && event.shiftKey && !event.altKey && key === "e") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) useTabOverviewStore.getState().toggle();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && key === "b") {
        event.preventDefault();
        state.toggleSidebar();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && key === "k") {
        event.preventDefault();
        useWorkspaceUiStore.getState().openGlobalSearch();
        return;
      }
      if (mod && event.altKey && !event.shiftKey && key === "o") {
        event.preventDefault();
        const workspaceId = useWorkspacePlatformStore.getState().activeWorkspaceId;
        state.setActiveSideTab("workspaces");
        state.setSidebarCollapsed(false);
        useWorkspaceUiStore.getState().openSessionPicker(workspaceId);
        return;
      }
      // Alt+Insert: new file in the active workspace (IDEA binding).
      if (event.altKey && !mod && !event.shiftKey && key === "insert" && inWorkspace && !isTypingTarget(event.target)) {
        event.preventDefault();
        useWorkspaceUiStore.getState().openFsModal({ kind: "file", directory: "" });
        return;
      }
      // Ctrl+Shift+H: tab details overlay is owned by the tab bar; do nothing.
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

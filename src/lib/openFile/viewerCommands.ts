import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { useDocumentStore } from "../../stores/documentStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { documentPathKey } from "./pathIdentity";
import { getAppPlatform } from "../runtime";

function activeViewer() {
  const app = useAppStore.getState();
  if (app.activeSideTab === "workspaces") {
    const workspace = useWorkspacePlatformStore.getState().getWorkspace();
    return workspace?.openTabs.find((tab) => tab.id === workspace.activeTabId)?.fileViewer;
  }
  if (app.activeSideTab !== "sessions" && app.activeSideTab !== "tools") return undefined;
  return app.tabs.find((tab) => tab.id === app.activeTabId)?.fileViewer;
}

/** Reuse the shell's native-menu command channel without claiming the IDE
 * action host. Save dispatch consults the live active document each time. */
export function activeViewerCommands(): WorkspaceCommandRegistration | null {
  const viewer = activeViewer();
  if (!viewer) return null;
  const document = useDocumentStore.getState().documents[documentPathKey(viewer.path)];
  const enabled = !!document && !document.readOnly && document.dirty && !document.saving && !document.loading;
  const key = `${viewer.path}:${enabled}`;
  if (cached?.key === key) return cached.registration;
  const registration: WorkspaceCommandRegistration = {
    items: [{ id: "viewer.save", title: "保存 / Save", category: "File", keybinding: getAppPlatform() === "macos" ? "Meta+S" : "Ctrl+S", enabled }],
    snapshot: [],
    executeAction: async (id) => {
      const current = activeViewer();
      if (id !== "viewer.save" || !current) return { kind: "no-op", reason: "unknown-action" };
      try { await useDocumentStore.getState().save(current.path); return { kind: "applied" }; }
      catch (error) { return { kind: "failed", reason: "exception", message: String(error), retryable: true }; }
    },
    execute: (id) => { if (id !== "viewer.save") return false; void registration.executeAction(id); return true; },
  };
  cached = { key, registration };
  return registration;
}
let cached: { key: string; registration: WorkspaceCommandRegistration } | undefined;

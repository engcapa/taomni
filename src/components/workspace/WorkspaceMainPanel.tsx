import { FilePlus2, FolderPlus, MonitorSmartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CodeWorkspaceTab } from "../editor/CodeWorkspaceTab";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import {
  useWorkspacePlatformStore,
  type WorkspaceBottomTool,
} from "../../stores/workspacePlatformStore";
import type { CodeWorkspaceTabInfo } from "../../types";
import { createWorkspaceFileNode, createWorkspaceFolderNode } from "./workspaceFs";
import { WorkspaceFileEditor } from "./WorkspaceFileEditor";
import { WorkspaceFsModals } from "./WorkspaceFsModals";
import { WorkspaceGitPanel } from "./WorkspaceGitPanel";
import { WorkspaceSessionPane } from "./WorkspaceSessionPane";
import { WorkspaceSessionPickerModal } from "./WorkspaceSessionPickerModal";

const DOCK_TOOLS: WorkspaceBottomTool[] = [
  "terminal",
  "problems",
  "run",
  "find",
  "bookmarks",
  "todo",
  "services",
  "database",
];

/**
 * Main canvas of the Workspaces mode (AC-06/07/08).
 *
 * Routes the workspace's isolated tab list: files open our editor, the GIT tab
 * opens the built-in Git panel, session tabs open their production protocol
 * surface, and the legacy Code Workspace editor stays available as its own tab
 * for full IDEA parity. A collapsible bottom dock mirrors IDEA's tool windows.
 */
export function WorkspaceMainPanel({ visible = true }: { visible?: boolean }) {
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  return (
    <div data-testid="workspace-main-panel" className="relative flex min-h-0 flex-1 flex-col">
      {workspaces.map((workspace) => (
        <WorkspaceCanvas key={workspace.id} workspaceId={workspace.id} visible={visible && workspace.id === activeId} />
      ))}
    </div>
  );
}

function WorkspaceCanvas({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const [started, setStarted] = useState(visible);
  useEffect(() => { if (visible) setStarted(true); }, [visible]);
  if (!started && !visible) return null;
  return <WorkspaceCanvasContents workspaceId={workspaceId} visible={visible} />;
}

function WorkspaceCanvasContents({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const t = useT();
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === workspaceId));
  const openFileInWorkspace = useWorkspacePlatformStore((s) => s.openFileInWorkspace);
  const openGitTab = useWorkspacePlatformStore((s) => s.openGitTab);
  const openLocalTerminal = useWorkspacePlatformStore((s) => s.openLocalTerminalInWorkspace);
  const setBottomDockOpen = useWorkspacePlatformStore((s) => s.setBottomDockOpen);
  const setBottomDockTool = useWorkspacePlatformStore((s) => s.setBottomDockTool);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const sessionPickerOpen = useWorkspaceUiStore((s) => s.sessionPickerOpen);
  const sessionPickerWorkspaceId = useWorkspaceUiStore((s) => s.sessionPickerWorkspaceId);
  const closeSessionPicker = useWorkspaceUiStore((s) => s.closeSessionPicker);
  const openSessionPicker = useWorkspaceUiStore((s) => s.openSessionPicker);
  const openFsModal = useWorkspaceUiStore((s) => s.openFsModal);
  const fsModal = useWorkspaceUiStore((s) => s.fsModal);
  const closeFsModal = useWorkspaceUiStore((s) => s.closeFsModal);

  const codeWorkspaceInfo = useMemo<CodeWorkspaceTabInfo | null>(() => {
    if (!workspace) return null;
    return {
      repoRoot: workspace.rootFolders[0]?.path ?? "",
      workspaceId: workspace.id,
      workspaceInstanceId: `platform:${workspace.id}`,
      name: workspace.name,
      roots: workspace.rootFolders.map((root) => ({
        id: root.id,
        name: root.name,
        path: root.path,
        kind: "folder" as const,
      })),
      looseFiles: [],
    };
  }, [workspace?.id, workspace?.name, workspace?.rootFolders]);

  if (!workspace) return null;

  const activeTab = workspace.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const codeTab = workspace.openTabs.find((tab) => tab.kind === "code");
  const dock = workspace.bottomDock;

  const submitFsModal = async (value: string) => {
    const root = (fsModal?.rootFolderId
      ? workspace.rootFolders.find((folder) => folder.id === fsModal.rootFolderId)
      : undefined) ?? workspace.rootFolders[0];
    try {
      if (fsModal?.kind === "root") {
        useWorkspacePlatformStore.getState().addRootFolder(workspace.id, { path: value });
        setStatusMessage(`${value} added to ${workspace.name}`);
      } else {
        if (!root) return;
        const relative = fsModal?.directory ? `${fsModal.directory.replace(/\/+$/, "")}/${value}` : value;
        if (fsModal?.kind === "file") {
          await createWorkspaceFileNode(root.path, relative);
          useWorkspacePlatformStore.getState().createFileInWorkspace(workspace.id, root.id, relative);
        } else {
          await createWorkspaceFolderNode(root.path, relative);
          useWorkspacePlatformStore.getState().createFolderInWorkspace(workspace.id, root.id, relative);
        }
        setStatusMessage(`Created ${relative}`);
      }
      closeFsModal();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div data-workspace-id={workspace.id} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col" style={{ display: visible ? "flex" : "none" }}>
      <div className="relative flex min-h-0 flex-1">
        {!activeTab && codeTab === undefined && (
          <div data-testid="workspace-empty-state" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
            <div className="text-[14px] font-semibold">{t("platform.emptyWorkspaceTitle")}</div>
            <div className="text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.emptyWorkspaceHint")}</div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button type="button" data-testid="workspace-empty-add-folder" className="taomni-btn h-7 px-2 inline-flex items-center gap-1" onClick={() => openFsModal({ kind: "root", directory: "" })}>
                <FolderPlus className="h-3.5 w-3.5" />
                {t("platform.addRootFolder")}
              </button>
              <button type="button" data-testid="workspace-empty-new-file" className="taomni-btn h-7 px-2 inline-flex items-center gap-1" onClick={() => openFsModal({ kind: "file", directory: "" })}>
                <FilePlus2 className="h-3.5 w-3.5" />
                {t("platform.newFile")}
              </button>
              <button type="button" data-testid="workspace-empty-open-session" className="taomni-btn h-7 px-2 inline-flex items-center gap-1" onClick={() => openSessionPicker(workspace.id)}>
                <MonitorSmartphone className="h-3.5 w-3.5" />
                {t("platform.openAnySession")}
              </button>
              <button type="button" data-testid="workspace-empty-local-terminal" className="taomni-btn h-7 px-2 inline-flex items-center gap-1" onClick={() => openLocalTerminal(workspace.id)}>
                {t("platform.newLocalTerminal")}
              </button>
            </div>
          </div>
        )}

        {workspace.openTabs.filter((tab) => tab.kind === "file").map((tab) => (
          <WorkspaceFileEditor
            key={tab.id}
            workspace={workspace}
            tab={tab}
            visible={visible && activeTab?.id === tab.id}
            onOpenGitDiff={(path) => openGitTab(workspace.id, path)}
          />
        ))}

        {workspace.openTabs.filter((tab) => tab.kind === "git").map((tab) => (
          <div key={tab.id} className="h-full min-h-0 w-full" style={{ display: activeTab?.id === tab.id ? "block" : "none" }}>
            <WorkspaceGitPanel
              workspace={workspace}
              visible={visible && activeTab?.id === tab.id}
              focusPath={tab.focusPath}
              onOpenFile={(rootId, path) => openFileInWorkspace(workspace.id, { rootId, path })}
            />
          </div>
        ))}

        {workspace.openTabs.filter((tab) => ["terminal", "sftp", "database", "rdp", "vnc"].includes(tab.kind)).map((tab) => (
          <div key={tab.id} className="h-full min-h-0 w-full" style={{ display: activeTab?.id === tab.id ? "block" : "none" }}>
            <WorkspaceSessionPane workspace={workspace} tab={tab} visible={visible && activeTab?.id === tab.id} />
          </div>
        ))}

        {codeTab && codeWorkspaceInfo && (
          <div
            data-testid="workspace-code-tab"
            className="h-full min-h-0 w-full"
            style={{ display: activeTab?.id === codeTab.id ? "block" : "none" }}
          >
            <CodeWorkspaceTab
              tabId={codeTab.id}
              workspace={codeWorkspaceInfo}
              visible={visible && activeTab?.id === codeTab.id}
              onOpenGitManager={(payload) => {
                const firstWithChanges = payload.roots[0];
                void firstWithChanges;
                openGitTab(workspace.id);
              }}
              onSyncGitManager={() => undefined}
              onCommandsChange={() => undefined}
            />
          </div>
        )}
      </div>

      {dock.open && (
        <div data-testid="workspace-bottom-dock" className="flex shrink-0 flex-col border-t" style={{ borderColor: "var(--taomni-divider)", height: dock.heightPx, background: "var(--taomni-panel-bg)" }}>
          <div className="flex h-7 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--taomni-divider)" }}>
            {DOCK_TOOLS.map((tool) => (
              <button
                key={tool}
                type="button"
                data-testid={`workspace-dock-tab-${tool}`}
                aria-pressed={dock.activeTool === tool}
                className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold capitalize"
                style={{
                  background: dock.activeTool === tool ? "var(--taomni-selected)" : "transparent",
                  color: dock.activeTool === tool ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                }}
                onClick={() => setBottomDockTool(workspace.id, tool)}
              >
                {t(`platform.${tool === "run" ? "runDebug" : tool}` as never) || tool}
              </button>
            ))}
            <div className="flex-1" />
            <button
              type="button"
              data-testid="workspace-dock-close"
              aria-label={t("common.close")}
              className="rounded p-1 hover:bg-[var(--taomni-hover)]"
              onClick={() => setBottomDockOpen(workspace.id, false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="workspace-dock-content" data-tool={dock.activeTool}>
            {dock.activeTool === "terminal" ? (
              <TerminalPanel tabId={`${workspace.id}:dock-terminal`} tabTitle="Workspace terminal" visible={visible} />
            ) : (
              <div className="p-3 text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>
                {t("platform.emptyWorkspaceHint")}
              </div>
            )}
          </div>
        </div>
      )}

      <WorkspaceSessionPickerModal
        open={visible && sessionPickerOpen}
        workspaceId={sessionPickerWorkspaceId ?? workspace.id}
        onClose={closeSessionPicker}
      />
      <WorkspaceFsModals request={visible ? fsModal : null} onCancel={closeFsModal} onSubmit={submitFsModal} />
    </div>
  );
}

export type { WorkspaceBottomTool };

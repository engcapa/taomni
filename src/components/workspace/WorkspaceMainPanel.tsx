import { memo, useEffect, useState } from "react";
import { type WorkspaceCodeEditorProps } from "./WorkspaceCodeEditor";
import { WorkspaceFileSurface } from "./WorkspaceFileSurface";
import { WorkspaceBottomDock } from "./WorkspaceBottomDock";
import { useAppStore } from "../../stores/appStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { openPlatformCodeWorkspace } from "../../lib/openPlatformCodeWorkspace";
import {
  useWorkspacePlatformStore,
  type WorkspaceBottomTool,
} from "../../stores/workspacePlatformStore";
import { createWorkspaceFileNode, createWorkspaceFolderNode } from "./workspaceFs";
import { WorkspaceFsModals } from "./WorkspaceFsModals";
import { WorkspaceGitPanel } from "./WorkspaceGitPanel";
import { WorkspaceSessionPane } from "./WorkspaceSessionPane";
import { WorkspaceSessionPickerModal } from "./WorkspaceSessionPickerModal";
import { revealWorkspaceFolder } from "./workspaceFolderReveal";
import { NOTES_WORKSPACE_ID } from "../../stores/workspaceNotes";
import { NotesWorkspace } from "../notes/NotesWorkspace";
import { ExplorerTabPane } from "../explorer/ExplorerTabPane";
import { ViewerShell } from "../viewer/ViewerShell";

/**
 * Main canvas of the Workspaces mode (AC-06/07/08).
 *
 * Routes the workspace's isolated tab list: files open our editor, the GIT tab
 * opens the built-in Git panel, session tabs open their production protocol
 * surface, and the legacy Code Workspace editor stays available as its own tab
 * for full IDEA parity. A collapsible bottom dock mirrors IDEA's tool windows.
 */
type CommandProps = Pick<WorkspaceCodeEditorProps, "onCommandsChange"> & { onEditSession?: (sessionId: string) => void };

export const WorkspaceMainPanel = memo(function WorkspaceMainPanel({ visible = true, onCommandsChange, onEditSession }: { visible?: boolean } & CommandProps) {
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  return (
    <div data-testid="workspace-main-panel" className="relative flex min-h-0 flex-1 flex-col">
      {workspaces.map((workspace) => (
        <WorkspaceCanvas key={workspace.id} workspaceId={workspace.id} visible={visible && workspace.id === activeId} onCommandsChange={onCommandsChange} onEditSession={onEditSession} />
      ))}
    </div>
  );
});

const WorkspaceCanvas = memo(function WorkspaceCanvas({ workspaceId, visible, onCommandsChange, onEditSession }: { workspaceId: string; visible: boolean } & CommandProps) {
  const [started, setStarted] = useState(visible);
  useEffect(() => { if (visible) setStarted(true); }, [visible]);
  if (!started && !visible) return null;
  return <WorkspaceCanvasContents workspaceId={workspaceId} visible={visible} onCommandsChange={onCommandsChange} onEditSession={onEditSession} />;
});

function WorkspaceCanvasContents({ workspaceId, visible, onCommandsChange, onEditSession }: { workspaceId: string; visible: boolean } & CommandProps) {
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === workspaceId));
  const setActiveTab = useWorkspacePlatformStore((s) => s.setActiveWorkspaceTab);
  const openFileInWorkspace = useWorkspacePlatformStore((s) => s.openFileInWorkspace);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const sessionPickerOpen = useWorkspaceUiStore((s) => s.sessionPickerOpen);
  const sessionPickerWorkspaceId = useWorkspaceUiStore((s) => s.sessionPickerWorkspaceId);
  const closeSessionPicker = useWorkspaceUiStore((s) => s.closeSessionPicker);
  const fsModal = useWorkspaceUiStore((s) => s.fsModal);
  const closeFsModal = useWorkspaceUiStore((s) => s.closeFsModal);
  const canvasLayout = useWorkspaceUiStore((s) => s.canvasLayouts[workspaceId] ?? "single");

  if (!workspace) return null;
  if (workspace.id === NOTES_WORKSPACE_ID) return <NotesWorkspace workspace={workspace} visible={visible} onCommandsChange={onCommandsChange} />;

  const activeTab = workspace.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const codeTab = workspace.openTabs.find((tab) => tab.kind === "code");
  const ordered = activeTab ? [activeTab, ...workspace.openTabs.filter((tab) => tab.id !== activeTab.id)] : workspace.openTabs;
  const paneIds = new Set(ordered.slice(0, canvasLayout === "single" ? 1 : canvasLayout === "split" ? 2 : 4).map((tab) => tab.id));
  const surfaceCount = ordered.filter((tab) => paneIds.has(tab.id) && tab.kind !== "file" && tab.kind !== "code").length
    + (ordered.some((tab) => paneIds.has(tab.id) && (tab.kind === "file" || tab.kind === "code")) ? 1 : 0);
  const paneVisible = (id: string) => visible && paneIds.has(id);
  const paneStyle = (id: string) => ({ display: paneIds.has(id) ? "block" : "none", minWidth: 0, overflow: "hidden" as const });

  const submitFsModal = async (value: string) => {
    const root = (fsModal?.rootFolderId
      ? workspace.rootFolders.find((folder) => folder.id === fsModal.rootFolderId)
      : undefined) ?? workspace.rootFolders[0];
    try {
      if (fsModal?.kind === "root") {
        const added = useWorkspacePlatformStore.getState().addRootFolder(workspace.id, { path: value });
        if (!added) return;
        revealWorkspaceFolder(workspace.id, added.id);
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
      <div data-testid="workspace-canvas-panes" data-layout={canvasLayout} className="relative grid min-h-0 flex-1 gap-px" style={{ gridTemplateColumns: canvasLayout === "single" || surfaceCount < 2 ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))", gridTemplateRows: canvasLayout === "grid" && surfaceCount > 2 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", background: "var(--taomni-divider)" }}>
        {(() => {
          const editorTab = ordered.find((tab) => (tab.kind === "file" || tab.kind === "code") && paneIds.has(tab.id));
          return <div data-testid="workspace-canvas-pane" data-tab-id={editorTab?.id}
            style={{ display: editorTab || !activeTab ? "block" : "none", minWidth: 0, overflow: "hidden" }}>
            <WorkspaceFileSurface workspace={workspace} visible={visible && (!!editorTab || !activeTab)} onCommandsChange={onCommandsChange} />
          </div>;
        })()}

        {workspace.openTabs.filter((tab) => tab.kind === "git").map((tab) => (
          <div key={tab.id} data-testid="workspace-canvas-pane" data-tab-id={tab.id} onMouseDownCapture={() => setActiveTab(workspace.id, tab.id)} className="h-full min-h-0 w-full" style={paneStyle(tab.id)}>
            <WorkspaceGitPanel
              workspace={workspace}
              visible={paneVisible(tab.id)}
              focusPath={tab.focusPath}
              onOpenFile={(rootId, path) => {
                if (codeTab && workspace.codeWorkspace) {
                  openPlatformCodeWorkspace({
                    ...workspace.codeWorkspace,
                    initialFile: { kind: "root", rootId, path },
                  });
                } else {
                  openFileInWorkspace(workspace.id, { rootId, path });
                }
              }}
            />
          </div>
        ))}

        {workspace.openTabs.filter((tab) => tab.kind === "viewer" && tab.fileViewer).map((tab) => (
          <div key={tab.id} data-testid="workspace-canvas-pane" data-tab-id={tab.id} onMouseDownCapture={() => setActiveTab(workspace.id, tab.id)} className="h-full min-h-0 w-full" style={paneStyle(tab.id)}>
            <ViewerShell viewer={tab.fileViewer!} active={paneVisible(tab.id)} workspaceId={workspace.id} />
          </div>
        ))}

        {workspace.openTabs.filter((tab) => tab.kind === "explorer").map((tab) => (
          <div key={tab.id} data-testid="workspace-canvas-pane" data-tab-id={tab.id} onMouseDownCapture={() => setActiveTab(workspace.id, tab.id)} className="h-full min-h-0 w-full" style={paneStyle(tab.id)}>
            <ExplorerTabPane tabId={tab.id} initialPath={tab.explorerPath ?? workspace.rootFolders[0]?.path ?? ""} workspaceId={workspace.id} active={paneVisible(tab.id) && workspace.activeTabId === tab.id}
              onOpenTerminal={(path) => { useWorkspacePlatformStore.getState().openLocalTerminalInWorkspace(workspace.id, path); }} />
          </div>
        ))}

        {workspace.openTabs.filter((tab) => ["terminal", "sftp", "database", "rdp", "vnc", "session"].includes(tab.kind)).map((tab) => (
          <div key={tab.id} data-testid="workspace-canvas-pane" data-tab-id={tab.id} onMouseDownCapture={() => setActiveTab(workspace.id, tab.id)} className="h-full min-h-0 w-full" style={paneStyle(tab.id)}>
            <WorkspaceSessionPane workspace={workspace} tab={tab} visible={paneVisible(tab.id)} active={visible && workspace.activeTabId === tab.id} onEditSession={onEditSession} />
          </div>
        ))}

      </div>

      <WorkspaceBottomDock workspace={workspace} />

      <WorkspaceSessionPickerModal
        open={visible && sessionPickerOpen}
        workspaceId={sessionPickerWorkspaceId ?? workspace.id}
        onClose={closeSessionPicker}
      />
      <WorkspaceFsModals request={visible ? fsModal : null} initialPath={workspace.rootFolders[0]?.path} onCancel={closeFsModal} onSubmit={submitFsModal} />
    </div>
  );
}

export type { WorkspaceBottomTool };

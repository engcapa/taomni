import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ClipboardCopy, Copy, Pencil, Trash2, X } from "lucide-react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { promptAppDialog } from "../../lib/appDialogs";
import { writeText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore, type PlatformWorkspace, type WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useWorkspaceEditorHostStore } from "../../stores/workspaceEditorHostStore";

interface Props {
  workspace: PlatformWorkspace;
  tab: WorkspaceIsolatedTab;
  x: number;
  y: number;
  onClose: () => void;
}

export function WorkspaceTabContextMenu({ workspace, tab, x, y, onClose }: Props) {
  const t = useT();
  const index = workspace.openTabs.findIndex((item) => item.id === tab.id);
  const store = useWorkspacePlatformStore.getState();
  const fileMenus = useWorkspaceEditorHostStore((state) => state.fileMenus[workspace.id]);
  const fileItems = tab.kind === "file" && tab.rootFolderId && tab.filePath
    ? Object.values(fileMenus ?? {}).map((menu) => menu({ kind: "root", rootId: tab.rootFolderId!, path: tab.filePath! })).find(Boolean)
    : null;
  const closeTabs = (others: boolean) => {
    for (const item of workspace.openTabs) {
      if (item.closable && (!others || item.id !== tab.id)) store.closeWorkspaceTab(workspace.id, item.id);
    }
  };
  const rename = async () => {
    const title = await promptAppDialog({ title: t("tabs.rename"), initialValue: tab.title });
    if (title !== null) useWorkspacePlatformStore.getState().renameWorkspaceTab(workspace.id, tab.id, title);
  };
  const copyInfo = async () => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === tab.sessionId);
    const app = useAppStore.getState();
    const runtime = app.terminalRuntimeByTab[tab.id];
    const host = session?.host || tab.host;
    const port = session?.port ?? tab.port;
    const username = session?.username ?? tab.username;
    const text = [
      `Title: ${tab.title}`, `Type: ${tab.kind}`, `Connection: ${session?.session_type ?? tab.protocol ?? tab.kind}`,
      `Session: ${session?.name ?? t("tabs.detailsTemporaryLocal")}`, `Workspace: ${workspace.name}`,
      ...(host ? [`Host: ${host}`] : []), ...(port ? [`Port: ${port}`] : []), ...(username ? [`Username: ${username}`] : []),
      `CWD: ${app.cwdByTab[tab.id] ?? t("tabs.detailsCwdUnknown")}`, `State: ${runtime?.state ?? "unknown"}`,
      ...(runtime?.program ? [`Program: ${runtime.program}`] : []), `Tab ID: ${tab.id}`, `Workspace ID: ${workspace.id}`,
      ...(tab.sessionId ? [`Session ID: ${tab.sessionId}`] : []),
      ...(runtime?.backendSessionId ? [`Backend session: ${runtime.backendSessionId}`] : []),
    ].join("\n");
    try {
      await writeText(text);
      app.setStatusMessage(t("tabs.sessionInfoCopied"));
    } catch (error) {
      app.setStatusMessage(t("tabs.sessionInfoCopyFailed", { error: String(error) }));
    }
  };
  const move = (position: number) => store.moveWorkspaceTab(workspace.id, tab.id, position);
  const items: MenuItem[] = [
    ...(fileItems ? [{ label: t("platform.fileActions"), testId: "workspace-tab-file-actions", children: fileItems }, { label: "", separator: true }] : []),
    { label: t("tabs.close"), testId: "workspace-tab-context-close", icon: <X className="h-3 w-3" />, disabled: !tab.closable, onClick: () => store.closeWorkspaceTab(workspace.id, tab.id) },
    { label: t("tabs.closeOthersShort"), testId: "workspace-tab-context-close-others", icon: <Trash2 className="h-3 w-3" />, onClick: () => closeTabs(true) },
    { label: t("tabs.closeAll"), testId: "workspace-tab-context-close-all", icon: <Trash2 className="h-3 w-3" />, onClick: () => closeTabs(false) },
    { label: "", separator: true, onClick: () => undefined },
    { label: t("tabs.rename"), testId: "workspace-tab-context-rename", icon: <Pencil className="h-3 w-3" />, disabled: !tab.closable, onClick: () => void rename() },
    { label: t("tabs.duplicate"), testId: "workspace-tab-context-duplicate", icon: <Copy className="h-3 w-3" />, disabled: tab.kind !== "terminal", onClick: () => store.duplicateWorkspaceTab(workspace.id, tab.id, useAppStore.getState().cwdByTab[tab.id]) },
    { label: t("tabs.copySessionInfo"), testId: "workspace-tab-context-copy-info", icon: <ClipboardCopy className="h-3 w-3" />, onClick: () => void copyInfo() },
    { label: "", separator: true, onClick: () => undefined },
    { label: t("tabs.moveToFirst"), testId: "workspace-tab-context-move-first", icon: <ChevronFirst className="h-3 w-3" />, disabled: index === 0, onClick: () => move(0) },
    { label: t("tabs.moveLeft"), testId: "workspace-tab-context-move-left", icon: <ChevronLeft className="h-3 w-3" />, disabled: index === 0, onClick: () => move(index - 1) },
    { label: t("tabs.moveRight"), testId: "workspace-tab-context-move-right", icon: <ChevronRight className="h-3 w-3" />, disabled: index === workspace.openTabs.length - 1, onClick: () => move(index + 1) },
    { label: t("tabs.moveToLast"), testId: "workspace-tab-context-move-last", icon: <ChevronLast className="h-3 w-3" />, disabled: index === workspace.openTabs.length - 1, onClick: () => move(workspace.openTabs.length - 1) },
  ];
  return <ContextMenu testId="workspace-tab-context-menu" x={x} y={y} onClose={onClose} items={items} />;
}

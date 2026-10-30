import { createContext, useContext, useMemo } from "react";
import type { CodeWorkspaceFileRef } from "../../../types";
import type { OpenFileViewModel } from "./editorGroupTypes";
import type { MenuItem } from "../../ContextMenu";
import type { ToolWindowRailItem } from "./panels/ToolWindowRail";

export type WorkspaceFileMenu = (ref: CodeWorkspaceFileRef) => MenuItem[] | null;

/** The containing workbench owns navigation; the editor owns buffers and effects. */
export interface WorkspaceHostSnapshot {
  files: OpenFileViewModel[];
  activeFile: CodeWorkspaceFileRef | null;
}

export interface WorkspaceHostIntegration {
  active: boolean;
  editorVisible: boolean;
  leftToolAreaVisible: boolean;
  showEditorTabs: boolean;
  navigationItems: ToolWindowRailItem[];
  files: CodeWorkspaceFileRef[];
  activeFile: CodeWorkspaceFileRef | null;
  canvasLayout: "single" | "split" | "grid";
  paneFiles: CodeWorkspaceFileRef[];
  leftToolAreaHost: HTMLElement | null;
  onActivateFile: (ref: CodeWorkspaceFileRef) => void;
  onOpenGitDiff: (path: string) => void;
  onFolderOpened?: (rootId: string) => void;
  onActivateToolWindow: (toolId: string, side: "left" | "right" | "bottom") => void;
  onLeftToolAreaChange: (open: boolean) => void;
  registerFileMenu: (groupId: string, menu: WorkspaceFileMenu | null) => void;
  onSnapshot: (snapshot: WorkspaceHostSnapshot) => void;
  recoverDraft: (ref: CodeWorkspaceFileRef) => {
    text: string;
    savedText: string;
    hash: string | null;
  } | null;
}

// File requests have their own reconciliation owner. Chrome consumers must not
// recompose the workspace with the previous active buffer before it is applied.
export type WorkspaceHostPresentation = Omit<WorkspaceHostIntegration,
  "files" | "activeFile" | "canvasLayout" | "paneFiles" | "onSnapshot" | "recoverDraft">;

export const WorkspaceHostRequestContext = createContext<WorkspaceHostIntegration | null>(null);
export const WorkspaceHostContext = createContext<WorkspaceHostPresentation | null>(null);
export const useWorkspaceHost = () => useContext(WorkspaceHostContext);

export function useWorkspaceHostPresentation(host: WorkspaceHostIntegration | undefined): WorkspaceHostPresentation | null {
  return useMemo(() => host ? {
    active: host.active,
    editorVisible: host.editorVisible,
    leftToolAreaVisible: host.leftToolAreaVisible,
    leftToolAreaHost: host.leftToolAreaHost,
    showEditorTabs: host.showEditorTabs,
    navigationItems: host.navigationItems,
    onActivateFile: host.onActivateFile,
    onOpenGitDiff: host.onOpenGitDiff,
    onFolderOpened: host.onFolderOpened,
    onActivateToolWindow: host.onActivateToolWindow,
    onLeftToolAreaChange: host.onLeftToolAreaChange,
    registerFileMenu: host.registerFileMenu,
  } : null, [!!host, host?.active, host?.editorVisible, host?.leftToolAreaVisible,
    host?.leftToolAreaHost, host?.showEditorTabs, host?.navigationItems,
    host?.onActivateFile, host?.onOpenGitDiff, host?.onFolderOpened,
    host?.onActivateToolWindow, host?.onLeftToolAreaChange, host?.registerFileMenu]);
}

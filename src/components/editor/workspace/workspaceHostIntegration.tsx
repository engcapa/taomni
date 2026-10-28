import { createContext, useContext } from "react";
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

export const WorkspaceHostContext = createContext<WorkspaceHostIntegration | null>(null);
export const useWorkspaceHost = () => useContext(WorkspaceHostContext);

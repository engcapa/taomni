import { type MutableRefObject } from "react";
import { type LspDocumentDescriptor, type LspDocumentStatus, type LspServerStatus } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspCustomCommandConfig, type LspFileState, type OpenFileState } from "../codeWorkspaceModel";

export type LspFilesUpdater = (
  updater: Record<string, LspFileState>
    | ((current: Record<string, LspFileState>) => Record<string, LspFileState>),
) => void;

export interface UseWorkspaceLspSessionOptions {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  openFilesRef: MutableRefObject<Record<string, OpenFileState>>;
  updateLspFiles: LspFilesUpdater;
  onError: (message: string) => void;
  onRestart?: () => void;
  visible?: boolean;
  /** Source buffers request discovery; explicit refresh remains available. */
  autoDiscover?: boolean;
}

export interface PendingDocumentSync {
  file: OpenFileState;
  mode: "open" | "change";
}

export interface DocumentSyncQueue {
  closed: boolean;
  pending: PendingDocumentSync | null;
  waiters: Array<() => void>;
}

export interface WorkspaceLspSessionController {
  serverStatuses: LspServerStatus[];
  commandPrefs: Record<string, string>;
  customCommands: Record<string, LspCustomCommandConfig>;
  refreshServerStatuses: (forceRefresh?: boolean) => Promise<void>;
  updateCommandPref: (presetId: string, commandId: string) => void;
  updateCustomCommand: (presetId: string, patch: Partial<LspCustomCommandConfig>) => void;
  descriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  /**
   * Descriptor for a path that has no open buffer (library sources re-fetched from
   * the server). `documentUri` retargets the request at a virtual document.
   */
  descriptorForPath: (
    rootPath: string | null,
    filePath: string,
    documentUri?: string | null,
  ) => LspDocumentDescriptor;
  /** True when the language server has the given buffer and no didChange is in flight. */
  isDocumentSynced: (key: string, text: string) => boolean;
  documentVersion: (key: string) => number | null;
  /** Current provider session generation (bumped on every restart). */
  sessionGeneration: () => number;
  syncDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  waitForSyncQueue: (key: string) => Promise<void>;
  saveDocument: (file: OpenFileState, text: string) => Promise<void>;
  closeDocument: (file: OpenFileState) => void;
  closeDocumentAndWait: (file: OpenFileState) => Promise<void>;
  forgetDocument: (key: string) => void;
  updateStatus: (file: OpenFileState, status: LspDocumentStatus) => void;
  /** Stop this workspace's language servers so they restart on the next sync. */
  restartServers: () => void;
}

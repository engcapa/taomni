import type { StoreApi, UseBoundStore } from "zustand";
import { type AttachOptions, type FileEntry, type FileEntryDiagnostic } from "../../lib/sftp";

export type PaneSide = "local" | "remote";

export interface PaneState {
  path: string;
  entries: FileEntry[];
  selection: string[];
  loading: boolean;
  error: string | null;
  skippedEntryCount: number;
  entryDiagnostics: FileEntryDiagnostic[];
  history: string[];
  historyIndex: number;
  showHidden: boolean;
}

export interface SftpSessionState {
  sessionId: string;
  attached: boolean;
  attaching: boolean;
  homeDir: string | null;
  error: string | null;
  connectionOpts?: AttachOptions;
  remote: PaneState;
  local: PaneState;
}

/**
 * Minimal per-session shape that `FilePanel` reads. Both `useSftpStore` and
 * the object-storage store satisfy this, so `FilePanel` can be driven by
 * either via its optional `store` prop.
 */
export interface FilePanelSession {
  homeDir: string | null;
  local: PaneState;
  remote: PaneState;
}

/**
 * The slice of store actions `FilePanel` invokes. Kept deliberately small so a
 * non-SFTP store (e.g. object storage) only has to implement navigation +
 * selection, not the full attach/detach lifecycle.
 */
export interface FilePanelStore {
  sessions: Record<string, FilePanelSession>;
  listPath: (sessionId: string, side: PaneSide, path: string) => Promise<FileEntry[]>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  navigateBack: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateForward: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: PaneSide) => Promise<void>;
  refreshPane: (sessionId: string, side: PaneSide) => Promise<void>;
  setSelection: (sessionId: string, side: PaneSide, selection: string[]) => void;
  toggleHidden: (sessionId: string, side: PaneSide) => void;
}

/** A zustand bound-store hook that exposes the {@link FilePanelStore} surface. */
export type FilePanelStoreHook = UseBoundStore<StoreApi<FilePanelStore>>;

export interface SftpStoreState {
  sessions: Record<string, SftpSessionState>;
  listPath: FilePanelStore["listPath"];
  attach: (opts: AttachOptions) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  /**
   * Attach a session id to the store without opening any SFTP channel —
   * used by the embedded local file-browser tab (File session type) so it
   * can reuse the same `FilePanel` plumbing as the SFTP local pane while
   * never touching the remote side.
   */
  attachLocalOnly: (sessionId: string, initialPath?: string) => Promise<void>;
  ensureSession: (sessionId: string) => SftpSessionState;
  detach: (sessionId: string) => Promise<void>;
  /** Counterpart to `attachLocalOnly` — drops the store entry, no backend. */
  detachLocalOnly: (sessionId: string) => void;
  refreshPane: (sessionId: string, side: PaneSide) => Promise<void>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  navigateBack: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateForward: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateHome: (sessionId: string, side: PaneSide) => Promise<void>;
  setSelection: (sessionId: string, side: PaneSide, selection: string[]) => void;
  toggleHidden: (sessionId: string, side: PaneSide) => void;
  setError: (sessionId: string, error: string | null) => void;
}

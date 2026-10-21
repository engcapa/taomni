import { type FileEntry } from "../../../lib/sftp";
import { type FilePanelStoreHook, type PaneSide } from "../../../stores/sftpStore";
import { type MenuItem } from "../../ContextMenu";

export interface CrossPaneDragPayload {
  sessionId: string;
  side: PaneSide;
  paths: string[];
}

export interface ColWidths {
  name: number;
  size: number;
  mtime: number;
  type: number;
}

export interface FilePanelProps {
  sessionId: string;
  side: PaneSide;
  /**
   * Optional store driving this panel. Defaults to the SFTP store. The
   * object-storage browser passes its own store (same {@link FilePanelStore}
   * surface) so the panel renders buckets/objects with no SFTP coupling. Must
   * be stable across the component's lifetime (don't swap stores per render).
   */
  store?: FilePanelStoreHook;
  /** Optional subtitle (e.g. host) shown in muted text next to the LOCAL/REMOTE badge. */
  subtitle?: string;
  detachable?: boolean;
  onDetach?: () => void;
  onItemDoubleClick: (entry: FileEntry) => void;
  onItemContext?: (
    entry: FileEntry,
    anchor: { x: number; y: number; },
    selectedEntries: FileEntry[],
  ) => MenuItem[];
  onEmptyContext?: (anchor: { x: number; y: number; }) => MenuItem[];
  onCrossPaneDrop?: (entries: FileEntry[]) => void;
  acceptCrossPane?: boolean;
  /** Optional substring filter typed by the user (case-insensitive). */
  filterText?: string;
  /** Mutator wired to the filter text input. */
  onFilterTextChange?: (next: string) => void;
  /** Toolbar callbacks operating on the current selection / current dir. */
  onDownloadSelected?: (entries: FileEntry[]) => void;
  onUploadSelected?: (entries: FileEntry[]) => void;
  onUploadFromDisk?: (files: File[]) => void;
  onUploadPathsFromDisk?: (paths: string[]) => void;
  onDeleteSelected?: (entries: FileEntry[]) => void;
  onChmodSelected?: (entries: FileEntry[]) => void;
  onPreviewSelected?: (entry: FileEntry) => void;
  onNewFolder?: () => void;
  onNewFile?: () => void;
  onOpenTerminalHere?: (path: string) => void;
  /** Local pane only: open selected files/dirs with the system default app. */
  onOpenLocalSelected?: (entries: FileEntry[]) => void;
  /** Local pane only: reveal the current directory in the OS file manager. */
  onRevealInOs?: (path: string) => void;
}

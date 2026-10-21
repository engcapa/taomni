export type Orientation = "horizontal" | "vertical";

export interface FileBrowserProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  initialPath?: string;
  onDetach?: () => void;
  onClose?: () => void;
  onTerminalSync?: (cwd: string) => void;
  cwdHint?: string | null;
  cwdHintVersion?: number;
  onRequestTerminalCwd?: () => boolean;
  detachable?: boolean;
  /** Default split direction; user can flip with the toolbar button. */
  defaultOrientation?: Orientation;
  /** Show a compact title-bar with detach/close buttons. */
  showHeader?: boolean;
  /** Title shown when `showHeader` is on. */
  title?: string;
  /** Persistence key for the orientation toggle. */
  orientationScope?: string;
  /** When set (attached sidebar), sends a `cd <path>\n` to the parent terminal. */
  onOpenTerminalHere?: (path: string) => void;
  /** Deployment path mappings for this session. */
  pathMappings?: import("../../../types").SftpPathMapping[];
  /** One-shot upload request created by an attached SSH terminal paste/drop. */
  pendingUploadRequest?: SftpPendingUploadRequest | null;
  onPendingUploadRequestHandled?: (requestId: number) => void;
}

export interface SftpPendingUploadRequest {
  id: number;
  paths: string[];
  remoteDir: string;
}

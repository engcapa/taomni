import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type { TerminalProfile } from "../lib/terminalProfile";
import type { RdpOptions } from "./rdp";

export type TabKind = "terminal" | "sftp" | "rdp" | "vnc" | "nettools" | "welcome" | "settings" | "placeholder" | "file-browser";

export interface VncConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
}

export interface RdpConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  /** JSON blob mirroring the SSH `networkSettings` shape; null = direct. */
  networkSettingsJson?: string | null;
}

export interface FileBrowserTabInfo {
  initialPath: string;
}

export interface Tab {
  id: string;
  type: TabKind;
  title: string;
  sessionId?: string;
  connectionId?: string;
  closable: boolean;
  ssh?: SshConnectInfo;
  localShell?: LocalShellSelection;
  terminalProfile?: TerminalProfile;
  message?: string;
  sftp?: SftpTabInfo;
  vnc?: VncConnectInfo;
  rdp?: RdpConnectInfo;
  fileBrowser?: FileBrowserTabInfo;
  hasNewOutput?: boolean;
}

export interface SftpTabInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  initialPath?: string;
  attachedToTerminal?: boolean;
}

export interface LocalShellSelection {
  id: string;
  name: string;
  args?: string[];
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

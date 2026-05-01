import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type { TerminalProfile } from "../lib/terminalProfile";

export type TabKind = "terminal" | "sftp" | "rdp" | "vnc" | "nettools" | "welcome" | "settings" | "placeholder";

export interface Tab {
  id: string;
  type: TabKind;
  title: string;
  sessionId?: string;
  connectionId?: string;
  closable: boolean;
  ssh?: SshConnectInfo;
  terminalProfile?: TerminalProfile;
  message?: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

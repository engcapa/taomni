import { Terminal as TerminalIcon, Monitor, Folder, Wifi, FileText, Globe, Cloud, Server, Network, Database, Mail } from "lucide-react";
import { type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import type { AuthMethod } from "../../../lib/ipc";
import { DEFAULT_MAIL_TERMINAL_PROFILE, getSessionTerminalProfile, loadTerminalDefaultProfile, parseSessionOptions, type TerminalProfile } from "../../../lib/terminalProfile";


/* ------------------------------------------------------------------ */
/*  Local types                                                        */
/* ------------------------------------------------------------------ */

export type Proto =
  | "SSH" | "Telnet" | "Rlogin" | "RDP" | "VNC" | "FTP" | "SFTP"
  | "Serial" | "File" | "Shell" | "Browser" | "Mosh" | "S3" | "WSL"
  | "MySQL" | "PostgreSQL" | "PanWeiDB" | "Oracle" | "SQLServer" | "StarRocks" | "ClickHouse" | "Presto" | "Redis" | "HBaseShell"
  | "Proxy" | "Mail";


export type SectionTab = "advanced" | "terminal" | "appearance" | "network" | "bookmark" | "rdp" | "vnc" | "database" | "mappings" | "proxy" | "objectstorage" | "mail";


export const PROTOS: { id: Proto; icon: React.ReactNode; color: string }[] = [
  { id: "SSH",     icon: <TerminalIcon className="w-7 h-7" />, color: "#2b5d8b" },
  { id: "Telnet",  icon: <TerminalIcon className="w-7 h-7" />, color: "#3b7ac2" },
  { id: "Rlogin",  icon: <TerminalIcon className="w-7 h-7" />, color: "#5b8a4a" },
  { id: "RDP",     icon: <Monitor className="w-7 h-7" />,      color: "#a04b9c" },
  { id: "VNC",     icon: <Monitor className="w-7 h-7" />,      color: "#c97a23" },
  { id: "FTP",     icon: <Folder className="w-7 h-7" />,       color: "#7a4f1a" },
  { id: "SFTP",    icon: <Folder className="w-7 h-7" />,       color: "#1e6db8" },
  { id: "Serial",  icon: <Wifi className="w-7 h-7" />,         color: "#236a98" },
  { id: "File",    icon: <FileText className="w-7 h-7" />,     color: "var(--taomni-text-muted)" },
  { id: "Shell",   icon: <TerminalIcon className="w-7 h-7" />, color: "#62d36f" },
  { id: "Browser", icon: <Globe className="w-7 h-7" />,        color: "#1e5fa8" },
  { id: "Mosh",    icon: <Server className="w-7 h-7" />,       color: "#7a3d9d" },
  { id: "S3",      icon: <Cloud className="w-7 h-7" />,        color: "#cc6f00" },
  { id: "WSL",     icon: <TerminalIcon className="w-7 h-7" />, color: "#0078d4" },
  { id: "MySQL",      icon: <Database className="w-7 h-7" />, color: "#00758f" },
  { id: "PostgreSQL", icon: <Database className="w-7 h-7" />, color: "#336791" },
  { id: "PanWeiDB",   icon: <Database className="w-7 h-7" />, color: "#0b8f6a" },
  { id: "Oracle",     icon: <Database className="w-7 h-7" />, color: "#c74634" },
  { id: "SQLServer",  icon: <Database className="w-7 h-7" />, color: "#cc2927" },
  { id: "StarRocks",  icon: <Database className="w-7 h-7" />, color: "#0f8f8c" },
  { id: "ClickHouse", icon: <Database className="w-7 h-7" />, color: "#e6a817" },
  { id: "Presto",     icon: <Database className="w-7 h-7" />, color: "#5a4fcf" },
  { id: "Redis",      icon: <Database className="w-7 h-7" />, color: "#d82c20" },
  { id: "HBaseShell", icon: <Database className="w-7 h-7" />, color: "#1d7f8c" },
  { id: "Proxy",     icon: <Network className="w-7 h-7" />, color: "#6b7280" },
  { id: "Mail",      icon: <Mail className="w-7 h-7" />,    color: "#256f6a" },
];


export const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22, Telnet: 23, Rlogin: 513, RDP: 3389, VNC: 5900,
  FTP: 21, SFTP: 22, Serial: 0, File: 0, Shell: 0,
  Browser: 0, Mosh: 60001, S3: 443, WSL: 0,
  MySQL: 3306, PostgreSQL: 5432, PanWeiDB: 5432, Oracle: 1521, SQLServer: 1433, StarRocks: 9030, ClickHouse: 9000, Presto: 8080, Redis: 6379,
  HBaseShell: 8080, Proxy: 3128, Mail: 993,
};


export const DB_PROTOS: Proto[] = ["MySQL", "PostgreSQL", "PanWeiDB", "Oracle", "SQLServer", "StarRocks", "ClickHouse", "Presto", "Redis"];

export const PLANNED_CLIENT_PROTOS = new Set<Proto>();


/** Map UI proto to the backend session_type string. Object storage ("S3"
 * proto) is resolved to "S3" vs "AzureBlob" by the caller based on the
 * selected provider. */
export function protoToSessionType(p: Proto): string {
  const map: Partial<Record<Proto, string>> = {
    Shell: "LocalShell",
    WSL: "LocalShell",
  };
  return map[p] ?? p;
}


export function sessionTypeToProto(type: string | undefined, optionsJson?: string | null): Proto {
  if (type === "Proxy") return "Proxy";
  // S3-family and Azure Blob both surface under the single "S3" (object
  // storage) tile; the concrete provider lives in options_json.
  if (type === "S3" || type === "AzureBlob") return "S3";
  if (type === "LocalShell") {
    const options = parseSessionOptions(optionsJson);
    const path = typeof options.localShellPath === "string" ? options.localShellPath : "";
    const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return basename === "wsl.exe" ? "WSL" : "Shell";
  }
  if (PROTOS.some((proto) => proto.id === type)) return type as Proto;
  return "SSH";
}


/* ------------------------------------------------------------------ */
/*  Helpers carried over from old implementation                       */
/* ------------------------------------------------------------------ */

export function extractKeyPath(auth: AuthMethod | undefined): string {
  if (auth && typeof auth === "object" && "PrivateKey" in auth) {
    return auth.PrivateKey.key_path;
  }
  return "";
}


export function extractAuthType(
  auth: AuthMethod | undefined,
): "Password" | "PrivateKey" | "Agent" | "Gssapi" | "None" {
  if (!auth) return "Password";
  if (typeof auth === "string") return auth as "Password" | "Agent" | "Gssapi" | "None";
  if (typeof auth === "object" && "PrivateKey" in auth) return "PrivateKey";
  return "Password";
}


export function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof options[key] === "boolean" ? options[key] : fallback;
}


export function optionString(options: Record<string, unknown>, key: string, fallback: string): string {
  return typeof options[key] === "string" ? options[key] : fallback;
}


export function optionStringOrNumber(options: Record<string, unknown>, key: string, fallback: string): string {
  const value = options[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}


export function stripDeprecatedCwdOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.followPath;
  delete next.osc7AutoInject;
  return next;
}


export function stripLocalShellLaunchOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.localShellPath;
  delete next.localShellArgs;
  delete next.wslDistro;
  delete next.wslUser;
  delete next.wslCwd;
  delete next.wslInitialCommand;
  delete next.wslAsAdministrator;
  return next;
}


export function stripSerialOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.serialDevice;
  delete next.serialBaud;
  return next;
}


export function stripTerminalProfileOption(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.terminalProfile;
  return next;
}


export function cloneNetworkSettings(settings: NetworkSettingsValue): NetworkSettingsValue {
  return {
    ...settings,
    localForwards: settings.localForwards.map((forward) => ({ ...forward })),
  };
}


export function initialTerminalProfileForProto(optionsJson: string | null | undefined, proto: Proto): TerminalProfile {
  const saved = getSessionTerminalProfile(optionsJson);
  if (saved) return saved;
  return defaultTerminalProfileForProto(proto);
}


export function defaultTerminalProfileForProto(proto: Proto): TerminalProfile {
  if (proto === "Mail") return DEFAULT_MAIL_TERMINAL_PROFILE;
  return loadTerminalDefaultProfile();
}

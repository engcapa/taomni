import { parseSessionOptions } from "./terminalProfile";

export type ProxyKind = "none" | "http" | "socks5" | "ssh-tunnel" | "system";
export type IpVersion = "auto" | "ipv4" | "ipv6";
export type JumpAuthKind = "Password" | "PrivateKey";

export interface NetworkForward {
  id: string;
  local: string;
  remote: string;
  desc: string;
}

export interface NetworkSettings {
  proxyKind: ProxyKind;
  proxyHost: string;
  proxyPort: string;
  proxyUser: string;
  proxyPass: string;
  proxySaveAuth: boolean;
  keepAlive: boolean;
  keepAliveIntervalSecs: string;
  tcpNodelay: boolean;
  disableNagle: boolean;
  ipVersion: IpVersion;
  localForwards: NetworkForward[];
  // --- SSH jump host (proxyKind === "ssh-tunnel") ---
  /** When set, the jump host is a saved SSH session resolved by the backend.
   *  Empty means use the manual jump fields below. */
  jumpSessionId: string;
  jumpHost: string;
  jumpPort: string;
  jumpUser: string;
  /** "Password" | "PrivateKey" */
  jumpAuthKind: JumpAuthKind;
  /** Password or vault:<id> ref; used when jumpAuthKind === "Password". */
  jumpPassword: string;
  /** Private key path; used when jumpAuthKind === "PrivateKey". */
  jumpKeyPath: string;
  /** Persist the manual jump password to the vault on save. */
  jumpSaveAuth: boolean;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyKind: "none",
  proxyHost: "",
  proxyPort: "",
  proxyUser: "",
  proxyPass: "",
  proxySaveAuth: false,
  keepAlive: true,
  keepAliveIntervalSecs: "60",
  // Backend honours `tcpNodelay` only; `disableNagle` is the
  // inverse-named UI mirror and is kept synchronized so saved sessions
  // can never carry contradictory values.
  tcpNodelay: true,
  disableNagle: true,
  ipVersion: "auto",
  localForwards: [],
  jumpSessionId: "",
  jumpHost: "",
  jumpPort: "22",
  jumpUser: "",
  jumpAuthKind: "Password",
  jumpPassword: "",
  jumpKeyPath: "",
  jumpSaveAuth: false,
};

const PROXY_LABEL_TO_KIND: Record<string, ProxyKind> = {
  "None — direct connection": "none",
  "HTTP CONNECT": "http",
  "SOCKS 5": "socks5",
  "Local SSH tunnel": "ssh-tunnel",
  "System proxy": "system",
};

const KIND_TO_PROXY_LABEL: Record<ProxyKind, string> = {
  none: "None — direct connection",
  http: "HTTP CONNECT",
  socks5: "SOCKS 5",
  "ssh-tunnel": "Local SSH tunnel",
  system: "System proxy",
};

const IP_LABEL_TO_KIND: Record<string, IpVersion> = {
  "Auto (prefer IPv4)": "auto",
  "Force IPv4": "ipv4",
  "Force IPv6": "ipv6",
};

const IP_KIND_TO_LABEL: Record<IpVersion, string> = {
  auto: "Auto (prefer IPv4)",
  ipv4: "Force IPv4",
  ipv6: "Force IPv6",
};

export function proxyLabelToKind(label: string): ProxyKind {
  return PROXY_LABEL_TO_KIND[label] ?? "none";
}
export function proxyKindToLabel(kind: ProxyKind): string {
  return KIND_TO_PROXY_LABEL[kind] ?? KIND_TO_PROXY_LABEL.none;
}
export function ipLabelToKind(label: string): IpVersion {
  return IP_LABEL_TO_KIND[label] ?? "auto";
}
export function ipKindToLabel(kind: IpVersion): string {
  return IP_KIND_TO_LABEL[kind] ?? IP_KIND_TO_LABEL.auto;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function readBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalizeForwards(value: unknown): NetworkForward[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((row) => ({
      id: readString(row.id, "") || (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
      local: readString(row.local, ""),
      remote: readString(row.remote, ""),
      desc: readString(row.desc, ""),
    }))
    .filter((row) => row.local.trim() && row.remote.trim());
}

export function normalizeNetworkSettings(input: unknown): NetworkSettings {
  const src = isRecord(input) ? input : {};
  const proxyKindRaw = readString(src.proxyKind, DEFAULT_NETWORK_SETTINGS.proxyKind);
  const ipVersionRaw = readString(src.ipVersion, DEFAULT_NETWORK_SETTINGS.ipVersion);
  return {
    proxyKind: (PROXY_LABEL_TO_KIND[proxyKindRaw] ??
      (Object.values(KIND_TO_PROXY_LABEL).includes(proxyKindRaw)
        ? (Object.entries(KIND_TO_PROXY_LABEL).find(([, l]) => l === proxyKindRaw)?.[0] as ProxyKind)
        : (proxyKindRaw as ProxyKind))) || "none",
    proxyHost: readString(src.proxyHost, ""),
    proxyPort: readString(src.proxyPort, ""),
    proxyUser: readString(src.proxyUser, ""),
    proxyPass: readString(src.proxyPass, ""),
    proxySaveAuth: readBoolean(src.proxySaveAuth, false),
    keepAlive: readBoolean(src.keepAlive, DEFAULT_NETWORK_SETTINGS.keepAlive),
    keepAliveIntervalSecs: readString(src.keepAliveIntervalSecs, DEFAULT_NETWORK_SETTINGS.keepAliveIntervalSecs),
    tcpNodelay: readBoolean(src.tcpNodelay, DEFAULT_NETWORK_SETTINGS.tcpNodelay),
    // `disableNagle` is the UI mirror of `tcpNodelay`; if the persisted
    // value is missing, force it to track `tcpNodelay`. If both are
    // present but contradict each other (older saved sessions), trust
    // `tcpNodelay` since that is the value the backend actually honours.
    disableNagle:
      src.disableNagle === undefined || src.disableNagle === null
        ? readBoolean(src.tcpNodelay, DEFAULT_NETWORK_SETTINGS.tcpNodelay)
        : readBoolean(src.tcpNodelay, DEFAULT_NETWORK_SETTINGS.tcpNodelay),
    ipVersion: (IP_LABEL_TO_KIND[ipVersionRaw] ?? (ipVersionRaw as IpVersion)) || "auto",
    localForwards: normalizeForwards(src.localForwards),
    jumpSessionId: readString(src.jumpSessionId, ""),
    jumpHost: readString(src.jumpHost, ""),
    jumpPort: readString(src.jumpPort, DEFAULT_NETWORK_SETTINGS.jumpPort),
    jumpUser: readString(src.jumpUser, ""),
    jumpAuthKind: readString(src.jumpAuthKind, "Password") === "PrivateKey" ? "PrivateKey" : "Password",
    jumpPassword: readString(src.jumpPassword, ""),
    jumpKeyPath: readString(src.jumpKeyPath, ""),
    jumpSaveAuth: readBoolean(src.jumpSaveAuth, false),
  };
}

export function getSessionNetworkSettings(optionsJson: string | null | undefined): NetworkSettings {
  const options = parseSessionOptions(optionsJson);
  return normalizeNetworkSettings(options.networkSettings);
}

/** Backend-facing payload sent over the IPC bridge. The Rust side
 *  treats this as `Option<NetworkSettings>` and ignores fields it doesn't
 *  understand, so we always serialise the full normalised shape. */
export interface NetworkSettingsPayload {
  proxyKind: ProxyKind;
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxyPass: string;
  keepAlive: boolean;
  keepAliveIntervalSecs: number;
  tcpNodelay: boolean;
  ipVersion: IpVersion;
  localForwards: { local: string; remote: string }[];
  jumpSessionId: string;
  jumpHost: string;
  jumpPort: number;
  jumpUser: string;
  jumpAuthKind: JumpAuthKind;
  jumpPassword: string;
  jumpKeyPath: string;
}

export function toNetworkSettingsPayload(ns: NetworkSettings): NetworkSettingsPayload {
  const port = parseInt(ns.proxyPort, 10);
  const interval = parseInt(ns.keepAliveIntervalSecs, 10);
  const jumpPort = parseInt(ns.jumpPort, 10);
  return {
    proxyKind: ns.proxyKind,
    proxyHost: ns.proxyHost.trim(),
    proxyPort: Number.isFinite(port) && port > 0 ? port : 0,
    proxyUser: ns.proxyUser,
    proxyPass: ns.proxyPass,
    keepAlive: ns.keepAlive,
    keepAliveIntervalSecs: Number.isFinite(interval) && interval > 0 ? interval : 0,
    // The "Disable Nagle algorithm" toggle is the inverse name of TCP_NODELAY;
    // the backend honours `tcpNodelay` only.
    tcpNodelay: ns.tcpNodelay,
    ipVersion: ns.ipVersion,
    localForwards: ns.localForwards
      .filter((f) => f.local.trim() && f.remote.trim())
      .map((f) => ({ local: f.local.trim(), remote: f.remote.trim() })),
    jumpSessionId: ns.jumpSessionId.trim(),
    jumpHost: ns.jumpHost.trim(),
    jumpPort: Number.isFinite(jumpPort) && jumpPort > 0 ? jumpPort : 22,
    jumpUser: ns.jumpUser.trim(),
    jumpAuthKind: ns.jumpAuthKind,
    jumpPassword: ns.jumpPassword,
    jumpKeyPath: ns.jumpKeyPath.trim(),
  };
}

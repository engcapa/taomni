import { getAppPlatform } from "./runtime";

const ROUTED_TYPES = new Set([
  "MySQL", "PostgreSQL", "PanWeiDB", "Oracle", "SQLServer", "StarRocks",
  "ClickHouse", "Presto", "Redis", "S3", "AzureBlob", "Mail",
]);
const TRANSPORT_TYPES = new Set(["SSH", "SFTP", "RDP", "VNC"]);
const TERMINAL_TYPES = new Set(["SSH", "LocalShell", "Shell", "WSL", "Serial", "FTP", "Telnet", "Rlogin", "Mosh"]);

/** Product capabilities, shared by configuration rendering and persistence. */
export function sessionCapabilities(type: string, platform = getAppPlatform()) {
  const ssh = type === "SSH";
  const sftp = type === "SFTP";
  return {
    network: TRANSPORT_TYPES.has(type) || ROUTED_TYPES.has(type),
    transportOptions: TRANSPORT_TYPES.has(type),
    sshAuthentication: ssh || sftp,
    sshShell: ssh,
    localForwards: ssh,
    keepAlive: ssh || sftp,
    terminal: TERMINAL_TYPES.has(type),
    username: !["Browser", "FTP", "Serial", "File", "LocalShell", "Shell", "WSL"].includes(type)
      && !(type === "Telnet" && platform === "windows"),
    storedPassword: TRANSPORT_TYPES.has(type) || ROUTED_TYPES.has(type) || type === "Proxy",
  };
}

/** Remove known inapplicable legacy keys, without discarding extension data. */
export function cleanSessionOptions(type: string, options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  const capabilities = sessionCapabilities(type);
  if (!capabilities.sshShell) {
    for (const key of ["x11", "x11Trusted", "startupCmd", "doNotExit", "remoteEnv", "sshBrowser"]) delete next[key];
  }
  if (!capabilities.sshAuthentication) {
    delete next.compression;
    delete next.usePrivKey;
  }
  if (!capabilities.storedPassword) delete next.passwordRef;
  if (type !== "File") {
    delete next.fileEmbedInTab;
    delete next.fileExtraArgs;
  }
  if (type !== "SFTP") delete next.pathMappings;
  if (!capabilities.terminal && type !== "Mail") delete next.terminalProfile;
  if (!capabilities.network) {
    delete next.networkSettings;
  } else if (next.networkSettings && typeof next.networkSettings === "object") {
    const network = { ...next.networkSettings as Record<string, unknown> };
    if (!capabilities.localForwards) delete network.localForwards;
    if (!capabilities.keepAlive) {
      delete network.keepAlive;
      delete network.keepAliveIntervalSecs;
    }
    if (!capabilities.transportOptions) {
      delete network.tcpNodelay;
      delete network.ipVersion;
    }
    delete network.disableNagle;
    next.networkSettings = network;
  }
  return next;
}

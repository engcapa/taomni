import { getAppPlatform } from "./runtime";

const DATABASE_TYPES = new Set(["MySQL", "PostgreSQL", "PanWeiDB", "Oracle", "SQLServer", "StarRocks", "ClickHouse", "Presto", "Redis"]);
const RDP_KEYS = ["domain", "colorDepth", "screenW", "screenH", "nla", "certificateFingerprint", "performance", "redirectClipboard", "redirectAudio", "redirectDrive", "gateway"];
const STORAGE_KEYS = ["provider", "endpoint", "region", "pathStyle", "accessKeyId", "secretAccessKey", "sessionToken", "defaultBucket", "awsAuth", "awsProfile", "accountName", "accountKey", "connectionString", "sasToken", "endpointSuffix", "defaultContainer", "azureAuth", "azureBearerToken", "storageClass"];

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
    detachedWindow: TERMINAL_TYPES.has(type) || ["SFTP", "RDP", "VNC", "MySQL", "PostgreSQL", "PanWeiDB", "Oracle", "SQLServer", "StarRocks", "ClickHouse", "Presto"].includes(type),
    username: !["Browser", "FTP", "Serial", "File", "LocalShell", "Shell", "WSL"].includes(type)
      && !(type === "Telnet" && platform === "windows"),
    storedPassword: TRANSPORT_TYPES.has(type) || ROUTED_TYPES.has(type) || type === "Proxy",
  };
}

/** Remove known inapplicable legacy keys, without discarding extension data. */
export function cleanSessionOptions(type: string, options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  const capabilities = sessionCapabilities(type);
  // These prefixes belong to established protocol schemas. Preserve unrelated
  // extension keys, but never carry another protocol's credentials or behavior.
  for (const key of Object.keys(next)) {
    if ((key.startsWith("mail") && type !== "Mail") ||
      (key.startsWith("hbase") && type !== "HBaseShell") ||
      (key.startsWith("vnc") && type !== "VNC") ||
      (key.startsWith("serial") && type !== "Serial") ||
      (key.startsWith("wsl") && type !== "WSL") ||
      (key.startsWith("localShell") && !["LocalShell", "Shell", "WSL"].includes(type)) ||
      (key.startsWith("db") && !DATABASE_TYPES.has(type) && type !== "HBaseShell")) delete next[key];
  }
  if (type !== "RDP") for (const key of RDP_KEYS) delete next[key];
  if (type !== "S3" && type !== "AzureBlob") for (const key of STORAGE_KEYS) delete next[key];
  if (type !== "Proxy") { delete next.proxyKind; delete next.testUrl; }
  if (type !== "ClickHouse") { delete next.dbChProtocol; delete next.dbHttpPort; }
  if (type !== "Presto") { delete next.dbPrestoDialect; delete next.dbCatalog; }
  if (type !== "Redis") delete next.dbRedisIndex;
  if (!capabilities.terminal) { delete next.bgImage; delete next.bgOpacity; }
  if (!capabilities.detachedWindow) delete next.openNewWindow;
  if (!capabilities.sshShell) delete next.reconnect;
  if (type === "Proxy" || type === "File") delete next.autoConnect;
  if (type === "Proxy") delete next.shortcut;
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
    if (!capabilities.sshAuthentication) {
      delete network.compression;
      delete network.sshExpert;
    }
    if (!capabilities.sshShell) delete network.sshBrowser;
    delete network.disableNagle;
    next.networkSettings = network;
  }
  return next;
}

import type { AuthMethod, SessionConfig } from "./ipc";
import { getSessionNetworkSettings, type NetworkSettings } from "./networkSettings";
import { parseSessionOptions } from "./terminalProfile";

export type ConnectionCommandPlatform = "posix" | "powershell";
export type SshConnectionCommandPreset = "basic" | "jump" | "forwards" | "full";

export type ConnectionCommandWarningCode =
  | "password-not-included"
  | "client-required"
  | "telnet-username-not-supported"
  | "proxy-not-included"
  | "saved-jump-not-found"
  | "jump-auth-not-included"
  | "startup-command-not-included"
  | "remote-env-not-included";

export interface ConnectionCommandWarning {
  code: ConnectionCommandWarningCode;
  detail?: string;
}

export type ConnectionCommandUnsupportedReason =
  | "unsupported-session-type"
  | "missing-host"
  | "missing-serial-device"
  | "missing-jump-host"
  | "missing-local-forwards";

export type ConnectionCommandBuildResult =
  | { ok: true; command: string; warnings: ConnectionCommandWarning[] }
  | { ok: false; reason: ConnectionCommandUnsupportedReason; warnings: ConnectionCommandWarning[] };

export interface BuildConnectionCommandOptions {
  platform: ConnectionCommandPlatform;
  sshPreset?: SshConnectionCommandPreset;
  allSessions?: readonly SessionConfig[];
}

const COMMAND_SESSION_TYPES = new Set(["SSH", "SFTP", "FTP", "Telnet", "Rlogin", "Mosh", "Serial"]);

const CLIENT_WARNING_TYPES = new Set(["FTP", "Telnet", "Rlogin", "Mosh", "Serial"]);

export function sessionSupportsConnectionCommand(session: Pick<SessionConfig, "session_type">): boolean {
  return COMMAND_SESSION_TYPES.has(session.session_type);
}

export function buildConnectionCommand(
  session: SessionConfig,
  options: BuildConnectionCommandOptions,
): ConnectionCommandBuildResult {
  if (!sessionSupportsConnectionCommand(session)) {
    return unsupported("unsupported-session-type");
  }

  switch (session.session_type) {
    case "SSH":
      return buildSshCommand(session, options);
    case "SFTP":
      return buildSftpCommand(session, options);
    case "FTP":
      return buildFtpCommand(session, options.platform);
    case "Telnet":
      return buildTelnetCommand(session, options.platform);
    case "Rlogin":
      return buildRloginCommand(session, options.platform);
    case "Mosh":
      return buildMoshCommand(session, options.platform);
    case "Serial":
      return buildSerialCommand(session, options.platform);
    default:
      return unsupported("unsupported-session-type");
  }
}

function buildSshCommand(
  session: SessionConfig,
  { platform, sshPreset = "basic", allSessions = [] }: BuildConnectionCommandOptions,
): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = sessionWarnings(session);
  const options = parseSessionOptions(session.options_json);
  const networkSettings = getSessionNetworkSettings(session.options_json);
  const args = [programName("ssh", platform)];

  addPort(args, "-p", session.port);
  addPrivateKey(args, session.auth_method);

  if (sshPreset === "jump" || sshPreset === "full") {
    const jump = resolveJumpHost(networkSettings, allSessions);
    warnings.push(...jump.warnings);
    if (!jump.spec) return { ok: false, reason: "missing-jump-host", warnings };
    args.push("-J", jump.spec);
  }

  if (sshPreset === "forwards" || sshPreset === "full") {
    const forwards = networkSettings.localForwards
      .map((forward) => `${forward.local.trim()}:${forward.remote.trim()}`)
      .filter((forward) => forward.trim());
    if (forwards.length === 0) return { ok: false, reason: "missing-local-forwards", warnings };
    for (const forward of forwards) {
      args.push("-L", forward);
    }
  }

  if (sshPreset === "full") {
    addFullSshOptions(args, options, networkSettings);
  }

  addNetworkWarnings(warnings, networkSettings, sshPreset === "jump" || sshPreset === "full");
  addUnsupportedOptionWarnings(warnings, options);
  args.push(sshTarget(session.username, host));

  return ok(args, platform, warnings);
}

function buildSftpCommand(
  session: SessionConfig,
  { platform, allSessions = [] }: BuildConnectionCommandOptions,
): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = sessionWarnings(session);
  const networkSettings = getSessionNetworkSettings(session.options_json);
  const args = [programName("sftp", platform)];
  addPort(args, "-P", session.port);
  addPrivateKey(args, session.auth_method);

  if (networkSettings.proxyKind === "ssh-tunnel") {
    const jump = resolveJumpHost(networkSettings, allSessions);
    warnings.push(...jump.warnings);
    if (jump.spec) args.push("-J", jump.spec);
    else warnings.push({ code: "saved-jump-not-found" });
  }

  addNetworkWarnings(warnings, networkSettings, networkSettings.proxyKind === "ssh-tunnel");
  args.push(sshTarget(session.username, host));
  return ok(args, platform, warnings);
}

function buildFtpCommand(session: SessionConfig, platform: ConnectionCommandPlatform): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = clientWarnings(session);
  addNetworkWarnings(warnings, getSessionNetworkSettings(session.options_json), false);
  const args = [programName("ftp", platform), host];
  if (session.port > 0) args.push(String(session.port));
  return ok(args, platform, warnings);
}

function buildTelnetCommand(session: SessionConfig, platform: ConnectionCommandPlatform): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = clientWarnings(session);
  addNetworkWarnings(warnings, getSessionNetworkSettings(session.options_json), false);
  const username = trimmed(session.username);
  const args = [programName("telnet", platform)];
  if (username && platform === "posix") {
    args.push("-l", username);
  } else if (username && platform === "powershell") {
    warnings.push({ code: "telnet-username-not-supported", detail: username });
  }
  args.push(host);
  if (session.port > 0) args.push(String(session.port));
  return ok(args, platform, warnings);
}

function buildRloginCommand(session: SessionConfig, platform: ConnectionCommandPlatform): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = clientWarnings(session);
  addNetworkWarnings(warnings, getSessionNetworkSettings(session.options_json), false);
  const args = [programName("rlogin", platform)];
  const username = trimmed(session.username);
  if (username) args.push("-l", username);
  if (session.port > 0 && session.port !== 513) args.push("-p", String(session.port));
  args.push(host);
  return ok(args, platform, warnings);
}

function buildMoshCommand(session: SessionConfig, platform: ConnectionCommandPlatform): ConnectionCommandBuildResult {
  const host = trimmed(session.host);
  if (!host) return unsupported("missing-host");

  const warnings = clientWarnings(session);
  addNetworkWarnings(warnings, getSessionNetworkSettings(session.options_json), false);
  const args = [programName("mosh", platform)];
  if (session.port > 0) args.push(`--port=${session.port}`);
  const username = trimmed(session.username);
  args.push(username ? `${username}@${hostForTarget(host)}` : hostForTarget(host));
  return ok(args, platform, warnings);
}

function buildSerialCommand(session: SessionConfig, platform: ConnectionCommandPlatform): ConnectionCommandBuildResult {
  const device = trimmed(session.host) || optionString(parseSessionOptions(session.options_json), "serialDevice");
  if (!device) return unsupported("missing-serial-device");

  const warnings = clientWarnings(session);
  const baud = serialBaud(session.options_json);
  const args = platform === "powershell"
    ? ["plink.exe", "-serial", device, "-sercfg", `${baud},8,n,1,N`]
    : ["screen", device, String(baud)];
  return ok(args, platform, warnings);
}

function addFullSshOptions(
  args: string[],
  options: Record<string, unknown>,
  networkSettings: NetworkSettings,
): void {
  if (options.compression === true) args.push("-C");

  if (options.x11 !== false) {
    args.push(options.x11Trusted === false ? "-X" : "-Y");
  }

  if (networkSettings.ipVersion === "ipv4") args.push("-4");
  if (networkSettings.ipVersion === "ipv6") args.push("-6");

  const interval = parsePositiveInteger(networkSettings.keepAliveIntervalSecs);
  if (networkSettings.keepAlive && interval > 0) {
    args.push("-o", `ServerAliveInterval=${interval}`);
  }
}

function addPrivateKey(args: string[], authMethod: AuthMethod): void {
  const keyPath = privateKeyPath(authMethod);
  if (keyPath) args.push("-i", keyPath);
}

function addPort(args: string[], flag: string, port: number): void {
  if (port > 0) args.push(flag, String(port));
}

function resolveJumpHost(
  networkSettings: NetworkSettings,
  allSessions: readonly SessionConfig[],
): { spec: string | null; warnings: ConnectionCommandWarning[] } {
  if (networkSettings.proxyKind !== "ssh-tunnel") return { spec: null, warnings: [] };

  const warnings: ConnectionCommandWarning[] = [];
  const jumpSessionId = networkSettings.jumpSessionId.trim();
  if (jumpSessionId) {
    const jumpSession = allSessions.find((candidate) => candidate.id === jumpSessionId && candidate.session_type === "SSH");
    if (!jumpSession) {
      return { spec: null, warnings: [{ code: "saved-jump-not-found", detail: jumpSessionId }] };
    }
    const host = trimmed(jumpSession.host);
    if (!host) return { spec: null, warnings: [{ code: "saved-jump-not-found", detail: jumpSessionId }] };
    warnings.push(...jumpAuthWarnings(jumpSession, true));
    return {
      spec: jumpSpec(jumpSession.username || "root", host, jumpSession.port || 22),
      warnings,
    };
  }

  const host = networkSettings.jumpHost.trim();
  if (!host) return { spec: null, warnings };

  const user = networkSettings.jumpUser.trim();
  if (networkSettings.jumpAuthKind === "PrivateKey" && networkSettings.jumpKeyPath.trim()) {
    warnings.push({ code: "jump-auth-not-included", detail: networkSettings.jumpKeyPath.trim() });
  }
  if (networkSettings.jumpAuthKind === "Password" && networkSettings.jumpPassword.trim()) {
    warnings.push({ code: "jump-auth-not-included" });
  }
  return { spec: jumpSpec(user, host, parsePositiveInteger(networkSettings.jumpPort) || 22), warnings };
}

function jumpSpec(username: string | null | undefined, host: string, port: number): string {
  const targetHost = hostForTarget(host);
  const user = trimmed(username);
  const destination = user ? `${user}@${targetHost}` : targetHost;
  return port > 0 ? `${destination}:${port}` : destination;
}

function sshTarget(username: string | null | undefined, host: string): string {
  return `${trimmed(username) || "root"}@${hostForTarget(host)}`;
}

function hostForTarget(host: string): string {
  const value = host.trim();
  if (value.includes(":") && !value.startsWith("[") && !value.endsWith("]")) {
    return `[${value}]`;
  }
  return value;
}

function privateKeyPath(authMethod: AuthMethod): string {
  if (typeof authMethod === "object" && "PrivateKey" in authMethod) {
    return authMethod.PrivateKey.key_path.trim();
  }
  return "";
}

function sessionWarnings(session: SessionConfig): ConnectionCommandWarning[] {
  return [
    ...passwordWarnings(session),
    ...jumpAuthWarnings(session, false),
  ];
}

function clientWarnings(session: SessionConfig): ConnectionCommandWarning[] {
  const warnings: ConnectionCommandWarning[] = CLIENT_WARNING_TYPES.has(session.session_type)
    ? [{ code: "client-required", detail: session.session_type }]
    : [];
  warnings.push(...passwordWarnings(session));
  return warnings;
}

function passwordWarnings(session: SessionConfig): ConnectionCommandWarning[] {
  const options = parseSessionOptions(session.options_json);
  const passwordRef = optionString(options, "passwordRef");
  return passwordRef ? [{ code: "password-not-included" }] : [];
}

function jumpAuthWarnings(session: SessionConfig, jump: boolean): ConnectionCommandWarning[] {
  const options = parseSessionOptions(session.options_json);
  const passwordRef = optionString(options, "passwordRef");
  if (!jump || !passwordRef) return [];
  return [{ code: "jump-auth-not-included" }];
}

function addNetworkWarnings(
  warnings: ConnectionCommandWarning[],
  networkSettings: NetworkSettings,
  jumpIncluded: boolean,
): void {
  if (networkSettings.proxyKind === "none") return;
  if (networkSettings.proxyKind === "ssh-tunnel") {
    if (!jumpIncluded) warnings.push({ code: "proxy-not-included", detail: "ssh-tunnel" });
    return;
  }
  warnings.push({ code: "proxy-not-included", detail: networkSettings.proxyKind });
}

function addUnsupportedOptionWarnings(
  warnings: ConnectionCommandWarning[],
  options: Record<string, unknown>,
): void {
  if (optionString(options, "startupCmd")) warnings.push({ code: "startup-command-not-included" });
  const remoteEnv = options.remoteEnv;
  if (Array.isArray(remoteEnv) && remoteEnv.length > 0) warnings.push({ code: "remote-env-not-included" });
}

function serialBaud(optionsJson: string | null | undefined): number {
  const options = parseSessionOptions(optionsJson);
  const value = options.serialBaud;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 115_200;
}

function parsePositiveInteger(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function optionString(options: Record<string, unknown>, key: string): string {
  const value = options[key];
  return typeof value === "string" ? value.trim() : "";
}

function programName(base: string, platform: ConnectionCommandPlatform): string {
  return platform === "powershell" ? `${base}.exe` : base;
}

function ok(
  args: string[],
  platform: ConnectionCommandPlatform,
  warnings: ConnectionCommandWarning[],
): ConnectionCommandBuildResult {
  return {
    ok: true,
    command: args.map((arg) => quoteArg(arg, platform)).join(" "),
    warnings,
  };
}

function unsupported(reason: ConnectionCommandUnsupportedReason): ConnectionCommandBuildResult {
  return { ok: false, reason, warnings: [] };
}

function quoteArg(value: string, platform: ConnectionCommandPlatform): string {
  if (platform === "posix" && value.startsWith("~/")) {
    const rest = value.slice(2);
    const safeRest = /^[A-Za-z0-9_@%+=:,./~\-[\]]+$/;
    return safeRest.test(rest) ? value : `~/${quoteArg(rest, platform)}`;
  }
  const safe = platform === "powershell"
    ? /^[A-Za-z0-9_@%+=:,./\\~\-[\]]+$/
    : /^[A-Za-z0-9_@%+=:,./~\-[\]]+$/;
  if (value !== "" && safe.test(value)) return value;
  if (platform === "powershell") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

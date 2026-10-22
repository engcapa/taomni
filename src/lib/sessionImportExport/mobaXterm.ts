import type { AuthMethod, SessionConfig } from "../ipc";
import { leafGroupName, normalizeGroupPath, toStoredGroupPath } from "../sessionPaths";
import { parseSessionOptions } from "../terminalProfile";
import { type SessionImportOptions, type SessionImportResult, MAX_SESSIONS, type SessionExportResult, MAX_HOST_LENGTH, MAX_NAME_LENGTH, DEFAULT_PORTS, MAX_OPTION_LENGTH, MAX_PATH_LENGTH } from "./model";
import { toUint8Array, assertImportSize, resolveNow, combineImportFolder, finalizeImportResult, slugify, cleanText, sanitizePort, optionalCleanText, createSessionId, sanitizeOptions, isRecord, sanitizeInteger, relativeFolderPath, privateKeyPath, optionString } from "./shared";


export const MOBAXTERM_TYPE_TO_SESSION: Record<string, string> = {
  "0": "SSH",
  "4": "RDP",
  "5": "VNC",
  "7": "SFTP",
};


export const MOBAXTERM_EXPORT_TYPES: Record<string, { code: string; icon: string }> = {
  SSH: { code: "0", icon: "109" },
  RDP: { code: "4", icon: "91" },
  VNC: { code: "5", icon: "128" },
  SFTP: { code: "7", icon: "140" },
};


export function parseMobaXtermSessions(
  input: string | ArrayBuffer | Uint8Array,
  options: SessionImportOptions = {},
): SessionImportResult {
  const text = typeof input === "string" ? input : decodeMobaXtermText(toUint8Array(input));
  assertImportSize(text);

  const warnings: string[] = [];
  const sections = parseMobaIni(text);
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const section of sections) {
    const sectionFolder = normalizeGroupPath(section.subRep);
    const groupPath = combineImportFolder(options.targetFolder ?? null, sectionFolder);

    for (const entry of section.entries) {
      const session = mobaEntryToSession(entry.key, entry.value, groupPath, now, warnings, options.homeDir ?? null);
      if (session) {
        sessions.push(session);
      } else {
        skipped += 1;
      }
    }
  }

  if (sessions.length > MAX_SESSIONS) {
    warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
    skipped += sessions.length - MAX_SESSIONS;
    sessions.length = MAX_SESSIONS;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}


export function serializeMobaXtermSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const warnings: string[] = [];
  const sectionMap = new Map<string, SessionConfig[]>();
  const rootFolder = mobaRootFolder(scopeFolder);
  ensureMobaSection(sectionMap, rootFolder);

  for (const session of sessions) {
    const folder = mobaFolderForSession(session, scopeFolder);
    ensureMobaSection(sectionMap, folder);
    sectionMap.get(folder)?.push(session);
  }

  const sortedFolders = [...sectionMap.keys()].sort((a, b) => {
    if (a === rootFolder) return -1;
    if (b === rootFolder) return 1;
    return a.localeCompare(b);
  });

  let skipped = 0;
  const lines: string[] = [];
  let sectionIndex = 0;

  for (const folder of sortedFolders) {
    if (folder === rootFolder) {
      lines.push("[Bookmarks]");
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push(`ImgNum=${scopeFolder ? "41" : "42"}`);
    } else {
      sectionIndex += 1;
      lines.push("");
      lines.push(`[Bookmarks_${sectionIndex}]`);
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push("ImgNum=41");
    }

    const usedNames = new Set<string>();
    for (const session of sectionMap.get(folder) ?? []) {
      const line = mobaSessionLine(session, usedNames, warnings);
      if (line) {
        lines.push(line);
      } else {
        skipped += 1;
      }
    }
  }

  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.mxtsessions`,
    text: `${lines.join("\r\n")}\r\n`,
    mimeType: "application/octet-stream",
    warnings,
    skipped,
  };
}


export interface MobaSection {
  name: string;
  subRep: string | null;
  entries: Array<{ key: string; value: string }>;
}


export function parseMobaIni(text: string): MobaSection[] {
  const sections: MobaSection[] = [];
  let current: MobaSection = { name: "Bookmarks", subRep: null, entries: [] };
  let hasExplicitSection = false;

  const pushCurrent = () => {
    if (hasExplicitSection || current.entries.length > 0 || current.subRep !== null) {
      sections.push(current);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]]+)]$/.exec(trimmed);
    if (sectionMatch) {
      pushCurrent();
      current = { name: sectionMatch[1], subRep: null, entries: [] };
      hasExplicitSection = true;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1);

    if (key === "SubRep") {
      current.subRep = value;
    } else if (key !== "ImgNum") {
      current.entries.push({ key, value });
    }
  }

  pushCurrent();
  return sections.filter((section) => section.name === "Bookmarks" || /^Bookmarks_\d+$/.test(section.name));
}


export function mobaEntryToSession(
  rawName: string,
  rawValue: string,
  groupPath: string | null,
  now: number,
  warnings: string[],
  homeDir: string | null,
): SessionConfig | null {
  const value = rawValue.trimStart();
  const parts = value.split("#");
  const iconIndex = parts.findIndex((part, index) => /^\d+$/.test(part) && (parts[index + 1] ?? "").includes("%"));
  if (iconIndex < 0) {
    warnings.push(`Skipped "${rawName}" because it is not a supported MobaXterm session line.`);
    return null;
  }

  const basic = (parts[iconIndex + 1] ?? "").split("%");
  const typeCode = basic[0] ?? "";
  const sessionType = MOBAXTERM_TYPE_TO_SESSION[typeCode];
  if (!sessionType) {
    warnings.push(`Skipped "${rawName}" because MobaXterm type ${typeCode || "(empty)"} is not supported.`);
    return null;
  }

  const host = cleanText(mobaUnescape(basic[1] ?? ""), MAX_HOST_LENGTH);
  if (!host) {
    warnings.push(`Skipped "${rawName}" because host is empty.`);
    return null;
  }

  const name = cleanText(mobaUnescape(rawName), MAX_NAME_LENGTH) || host;
  const port = sanitizePort(basic[2], DEFAULT_PORTS[sessionType] ?? 0);
  const username = sessionType === "VNC" ? null : optionalCleanText(mobaUnescape(basic[3] ?? ""), MAX_NAME_LENGTH);
  const options = mobaBasicToOptions(sessionType, basic, parts[iconIndex + 4] ?? "");
  const authMethod = mobaBasicToAuth(sessionType, basic, homeDir);

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: toStoredGroupPath(groupPath),
    host,
    port,
    username,
    auth_method: authMethod,
    options_json: JSON.stringify(options),
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: 0,
  };
}


export function mobaBasicToOptions(
  sessionType: string,
  basic: string[],
  rawComment: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const comment = cleanText(mobaUnescape(rawComment), MAX_OPTION_LENGTH).trim();
  if (comment) options.description = comment;

  if (sessionType === "SSH") {
    options.x11 = basic[5] !== "0";
    options.compression = basic[6] !== "0";
    const startupCmd = cleanText(mobaUnescape(basic[7] ?? ""), MAX_OPTION_LENGTH);
    if (startupCmd) options.startupCmd = startupCmd;
    if (basic[11] === "-1" || basic[11] === "0") options.doNotExit = basic[11] === "-1";
    addMobaJumpOptions(options, basic[8], basic[9], basic[10]);
  } else if (sessionType === "SFTP") {
    options.compression = basic[5] === "-1";
  } else if (sessionType === "RDP") {
    const remoteCommand = cleanText(mobaUnescape(basic[12] ?? ""), MAX_OPTION_LENGTH);
    if (remoteCommand) options.startupCmd = remoteCommand;
    addMobaJumpOptions(options, basic[13], basic[14], basic[15]);
  } else if (sessionType === "VNC") {
    addMobaJumpOptions(options, basic[5], basic[6], basic[7]);
  }

  return sanitizeOptions(options);
}


export function addMobaJumpOptions(
  options: Record<string, unknown>,
  hostList: string | undefined,
  portList: string | undefined,
  userList: string | undefined,
) {
  const jumpHost = firstPipeValue(hostList);
  if (!jumpHost) return;
  options.useJump = true;
  options.jumpHost = jumpHost;
  options.jumpPort = firstPipeValue(portList) || "22";
  options.jumpUser = firstPipeValue(userList);
}


export function firstPipeValue(value: string | undefined): string {
  return cleanText(mobaUnescape((value ?? "").split("__PIPE__")[0] ?? ""), MAX_NAME_LENGTH);
}


export function mobaBasicToAuth(
  sessionType: string,
  basic: string[],
  homeDir: string | null,
): AuthMethod {
  const keyPath = sessionType === "SSH"
    ? mobaPrivateKeyPath(basic[14] ?? "", homeDir)
    : sessionType === "SFTP"
      ? mobaPrivateKeyPath(basic[9] ?? "", homeDir)
      : "";

  return keyPath ? { PrivateKey: { key_path: keyPath } } : sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None";
}


export function mobaPrivateKeyPath(rawPath: string, homeDir: string | null): string {
  const path = cleanText(mobaUnescape(rawPath), MAX_PATH_LENGTH);
  if (!path) return "";
  const profileMacro = "_ProfileDir_";
  if (!path.toLowerCase().startsWith(profileMacro.toLowerCase())) return path;

  const home = cleanText(homeDir, MAX_PATH_LENGTH) || "~";
  return joinHomeRelativePath(home, path.slice(profileMacro.length));
}


export function joinHomeRelativePath(homeDir: string, relativePath: string): string {
  const home = homeDir.trim().replace(/[\\/]+$/, "");
  if (!home) return cleanText(relativePath, MAX_PATH_LENGTH);
  const windows = /^[A-Za-z]:[\\/]/.test(home) || /^\\\\/.test(home);
  const sep = windows ? "\\" : "/";
  const relative = relativePath
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, sep);
  return cleanText(relative ? `${home}${sep}${relative}` : home, MAX_PATH_LENGTH);
}


export function mobaSessionLine(
  session: SessionConfig,
  usedNames: Set<string>,
  warnings: string[],
): string | null {
  const exportType = MOBAXTERM_EXPORT_TYPES[session.session_type];
  if (!exportType) {
    warnings.push(`Skipped "${session.name}" because MobaXterm export does not support ${session.session_type}.`);
    return null;
  }

  const name = uniqueMobaName(session.name || session.host || session.session_type, usedNames, warnings);
  const basic = mobaBasicGroup(session, exportType.code, warnings);
  const terminal = mobaTerminalGroup(session);
  const comment = safeMobaComment(optionString(parseSessionOptions(session.options_json).description), warnings);
  return `${name}=#${exportType.icon}#${basic.join("%")}#${terminal}#0#${comment || " "}#-1`;
}


export function mobaBasicGroup(
  session: SessionConfig,
  typeCode: string,
  warnings: string[],
): string[] {
  const options = parseSessionOptions(session.options_json);
  const host = safeMobaPercentField(session.host, "host", warnings);
  const port = String(sanitizePort(session.port, DEFAULT_PORTS[session.session_type] ?? 0));
  const username = safeMobaPercentField(session.username ?? "", "username", warnings);
  const privateKey = safeMobaPercentField(privateKeyPath(session.auth_method), "private key path", warnings);
  const jumpHost = safeMobaPercentField(optionString(options.jumpHost), "jump host", warnings);
  const jumpPort = safeMobaPercentField(optionString(options.jumpPort) || "22", "jump port", warnings);
  const jumpUser = safeMobaPercentField(optionString(options.jumpUser), "jump user", warnings);

  if (typeCode === "0") {
    const fields = [
      "0",
      host,
      port,
      username,
      "",
      options.x11 === false ? "0" : "-1",
      options.compression === true ? "-1" : "0",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      options.doNotExit === true ? "-1" : "0",
      username ? "0" : "-1",
      "0",
      privateKey,
      "",
      "-1",
      "0",
      "0",
      "0",
      "",
      "1080",
      "",
      "0",
      "0",
      "1",
      "",
      "0",
      "",
      "",
      "",
      "0",
      "-1",
      "-1",
      "0",
    ];
    return fields;
  }

  if (typeCode === "7") {
    return [
      "7",
      host,
      port,
      username,
      "-1",
      options.compression === true ? "-1" : "0",
      "",
      "0",
      "0",
      privateKey,
      "0",
      "",
      "1080",
      "",
      "",
      "",
      "-1",
    ];
  }

  if (typeCode === "4") {
    return [
      "4",
      host,
      port,
      username,
      "0",
      "0",
      "0",
      "0",
      "-1",
      "0",
      "0",
      "-1",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      "0",
      "0",
      "",
      "-1",
      "",
      "-1",
      "-1",
      "0",
      "-1",
      "0",
      "-1",
      "0",
      "0",
      "0",
      "0",
      "",
    ];
  }

  return [
    "5",
    host,
    port,
    "-1",
    "0",
    jumpHost,
    jumpHost ? jumpPort : "",
    jumpHost ? jumpUser : "",
    "",
    "-1",
    "0",
    "0",
    "",
    "0",
    "",
    "1080",
    "",
    "",
  ];
}


export function mobaTerminalGroup(session: SessionConfig): string {
  const profile = sanitizeOptions(session.options_json).terminalProfile;
  const terminalProfile = isRecord(profile) ? profile : {};
  const fontFamily = safeTerminalFont(optionString(terminalProfile.fontFamily));
  const fontSize = sanitizeInteger(terminalProfile.fontSize, 10);
  return [
    fontFamily,
    String(Math.min(32, Math.max(8, fontSize))),
    "0",
    "0",
    "-1",
    "15",
    "236,236,236",
    "30,30,30",
    "180,180,192",
    "0",
    "-1",
    "0",
    "",
    "xterm",
    "-1",
    "0",
    "_Std_Colors_0_",
    "80",
    "24",
    "0",
    "1",
    "-1",
    "<none>",
    "",
    "0",
    "0",
    "-1",
    "-1",
  ].join("%");
}


export function safeTerminalFont(value: string): string {
  const primary = value.split(",")[0]?.replace(/^["']|["']$/g, "").trim();
  return primary ? primary.replace(/[^\x20-\x7E]/g, "_").slice(0, 80) : "MobaFont";
}





export function decodeMobaXtermText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
    if (language.startsWith("zh")) {
      try {
        return new TextDecoder("gbk").decode(bytes);
      } catch {
        return new TextDecoder("windows-1252").decode(bytes);
      }
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}


export function mobaUnescape(value: string): string {
  return value
    .replace(/__PTVIRG__/g, ";")
    .replace(/__DBLQUO__/g, "\"")
    .replace(/__PIPE__/g, "|")
    .replace(/__DIEZE__/g, "#")
    .replace(/__PERCENT__/g, "%");
}


export function mobaRootFolder(scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  return scope ? leafGroupName(scope) : "";
}


export function mobaFolderForSession(session: SessionConfig, scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  const relative = relativeFolderPath(session.group_path, scopeFolder);
  if (!scope) return pathToMobaFolder(relative);
  const root = leafGroupName(scope);
  return relative ? pathToMobaFolder(`${root} / ${relative}`) : root;
}


export function pathToMobaFolder(path: string | null): string {
  return normalizeGroupPath(path)?.replace(/\s*\/\s*/g, "\\") ?? "";
}


export function ensureMobaSection(sectionMap: Map<string, SessionConfig[]>, folder: string) {
  const parts = folder.split("\\").filter(Boolean);
  if (parts.length === 0) {
    if (!sectionMap.has("")) sectionMap.set("", []);
    return;
  }
  for (let i = 1; i <= parts.length; i += 1) {
    const path = parts.slice(0, i).join("\\");
    if (!sectionMap.has(path)) sectionMap.set(path, []);
  }
}


export function safeMobaPercentField(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/%/g, "__PERCENT__")
    .replace(/;/g, "__PTVIRG__")
    .replace(/"/g, "__DBLQUO__")
    .replace(/\|/g, "__PIPE__")
    .replace(/#/g, "__DIEZE__")
    .replace(/\r?\n/g, " ");
}


export function safeMobaComment(value: string, warnings: string[]): string {
  return safeMobaAscii(value, "comment", warnings)
    .replace(/#/g, "__DIEZE__")
    .replace(/%/g, " ")
    .replace(/\r?\n/g, " ");
}


export function safeMobaIniValue(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/[\r\n=[\]]/g, " ")
    .trim();
}


export function uniqueMobaName(value: string, usedNames: Set<string>, warnings: string[]): string {
  const base = safeMobaIniValue(value, "session name", warnings) || "Session";
  let name = base;
  let index = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${index})`;
    index += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}


export function safeMobaAscii(value: string, label: string, warnings: string[]): string {
  const cleaned = cleanText(value, MAX_OPTION_LENGTH);
  const safe = cleaned.replace(/[^\x20-\x7E]/g, "_");
  if (safe !== cleaned) {
    warnings.push(`Some ${label} characters are not supported by MobaXterm export and were replaced.`);
  }
  return safe;
}




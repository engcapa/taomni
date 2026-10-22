import type { AuthMethod, SessionConfig } from "../ipc";
import { normalizeGroupPath } from "../sessionPaths";
import { type SessionImportOptions, type SessionImportResult, type SessionImportSecret, MAX_HOST_LENGTH, MAX_NAME_LENGTH, DEFAULT_PORTS, type ExternalVaultPrompt, MAX_SESSIONS, MAX_OPTION_LENGTH } from "./model";
import { assertImportSize, resolveNow, cleanText, firstString, isRecord, firstNonEmptyString, importedSession, firstKnown, optionalCleanText, combineImportFolder, finalizeImportResult, protocolToSessionType, normalizeImportPath, sanitizePort, parseSimpleScalar } from "./shared";


export function parseTabbySessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const { profiles, groupNames } = parseTabbyConfig(text, warnings);
  const vaultDetected = detectTabbyVault(text);
  const profileLookup = tabbyProfileLookup(profiles);
  const includeSecrets = options.includeSecrets === true;
  const sessions: SessionConfig[] = [];
  const secrets: SessionImportSecret[] = [];
  let skipped = 0;
  let externalPasswordCount = 0;

  for (const profile of profiles) {
    const type = cleanText(firstString(profile.type), 32).toLowerCase();
    if (type && type !== "ssh" && type !== "telnet") {
      skipped += 1;
      continue;
    }
    const optionsRecord = isRecord(profile.options) ? profile.options : {};
    const host = cleanText(firstNonEmptyString(optionsRecord.host, optionsRecord.hostname), MAX_HOST_LENGTH);
    if (!host) {
      skipped += 1;
      continue;
    }
    const sessionType = type === "telnet" ? "Telnet" : "SSH";
    const name = cleanText(firstNonEmptyString(profile.name, host), MAX_NAME_LENGTH);
    const profileLabel = name || host;
    const auth = tabbyAuthMethod(profileLabel, sessionType, optionsRecord, includeSecrets, warnings);
    if (auth.passwordHeldExternally) externalPasswordCount += 1;
    const importedOptions = tabbyOptions(profileLabel, profile, optionsRecord, profileLookup, warnings);
    const session = importedSession({
      name,
      sessionType,
      host,
      port: firstKnown(optionsRecord.port, DEFAULT_PORTS[sessionType]),
      username: optionalCleanText(firstNonEmptyString(optionsRecord.user, optionsRecord.username), MAX_NAME_LENGTH),
      groupPath: combineImportFolder(options.targetFolder ?? null, tabbyProfileFolder(profile, groupNames, profileLabel, warnings)),
      authMethod: auth.authMethod,
      options: importedOptions,
      now,
      warnings,
    });
    if (session) {
      sessions.push(session);
      if (auth.password) {
        secrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${session.username ?? "user"}@${session.host}:${session.port}`,
          value: auth.password,
        });
      }
    } else {
      skipped += 1;
    }
  }

  if (externalPasswordCount > 0) {
    if (vaultDetected) {
      warnings.push(
        `Tabby vault detected. Enter your Tabby master password when prompted to recover ${externalPasswordCount} saved password(s); the rest will be looked up in the OS keychain automatically.`,
      );
    } else {
      warnings.push(
        `Tabby keeps remembered passwords in the OS keychain (Credential Manager / Keychain / Secret Service). Taomni will read them automatically; ${externalPasswordCount} profile(s) using password auth still need an entry there.`,
      );
    }
  }

  const externalVault: ExternalVaultPrompt | undefined = vaultDetected
    ? {
        tool: "Tabby",
        rawText: text,
        description:
          "Enter your Tabby master password to unlock saved SSH credentials. Leave blank to skip — passwords stored only in the vault will need to be re-entered on first connect.",
      }
    : undefined;

  return finalizeImportResult(
    sessions,
    skipped,
    warnings,
    options.existingSessions,
    secrets,
    [],
    externalVault,
    "tabby",
  );
}


/**
 * Targeted scanner for the Tabby `vault:` block in `config.yaml`. The general
 * Tabby YAML parser ignores top-level keys other than `profiles`/`groups`,
 * so we run a small pass here just to detect whether the file contains an
 * encrypted secret blob worth prompting the user for.
 *
 * Detects: top-level `vault:` mapping with at least `contents:` and
 * `version: 1`. Returns true if both are present.
 */
export function detectTabbyVault(text: string): boolean {
  let inVault = false;
  let vaultIndent = -1;
  let hasContents = false;
  let hasVersion1 = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(rawLine);
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^\s*/)?.[0].length ?? 0;
    const line = stripped.trim();

    if (indent === 0) {
      // Leaving the vault block (or never entered one).
      if (inVault) break;
      if (/^vault:\s*$/.test(line) || /^vault:\s*\{?\s*$/.test(line)) {
        inVault = true;
        vaultIndent = indent;
      }
      continue;
    }

    if (!inVault) continue;
    if (indent <= vaultIndent) break;

    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === "contents" && value.length > 0) hasContents = true;
    if (key === "version" && value === "1") hasVersion1 = true;
  }

  return inVault && hasContents && hasVersion1;
}


export function parseWindTermSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected WindTerm session file is not valid JSON.");
  }

  const rows: WindTermRow[] = [];
  collectWindTermRows(parsed, [], rows, 0);
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const row of rows.slice(0, MAX_SESSIONS)) {
    const sessionType = protocolToSessionType(row.protocol, warnings);
    const session = importedSession({
      name: row.name || row.host,
      sessionType,
      host: row.host,
      port: row.port,
      username: row.username,
      groupPath: combineImportFolder(options.targetFolder ?? null, normalizeGroupPath(row.folder.join(" / "))),
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }
  skipped += Math.max(0, rows.length - MAX_SESSIONS);
  if (rows.length > MAX_SESSIONS) warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}


export interface WindTermRow {
  name: string;
  protocol: string;
  host: string;
  port: unknown;
  username: string | null;
  folder: string[];
}


export function tabbyProfileFolder(
  profile: Record<string, unknown>,
  groupNames: Map<string, string>,
  profileLabel: string,
  warnings: string[],
): string | null {
  const raw = firstNonEmptyString(
    profile.group,
    profile.groupPath,
    profile.group_path,
    profile.folder,
    profile.folderPath,
    profile.folder_path,
    profile.category,
  );
  const cleaned = cleanText(raw, MAX_OPTION_LENGTH);
  if (!cleaned) return null;

  const resolved = groupNames.get(cleaned);
  if (resolved) return normalizeGroupPath(resolved);

  if (TABBY_UUID_PATTERN.test(cleaned)) {
    warnings.push(`Tabby profile "${profileLabel}" references group "${cleaned}" but no matching entry was found under groups: — imported under the raw id.`);
  }
  return normalizeGroupPath(cleaned);
}


export const TABBY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export function tabbyProfileLookup(profiles: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  for (const profile of profiles) {
    for (const key of [
      firstString(profile.id),
      firstString(profile.name),
      firstString(profile.title),
    ]) {
      const normalized = key.trim();
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, profile);
    }
  }
  return lookup;
}


export function tabbyOptions(
  profileName: string,
  profile: Record<string, unknown>,
  optionsRecord: Record<string, unknown>,
  profileLookup: Map<string, Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown> {
  const imported: Record<string, unknown> = {
    description: "Imported from Tabby",
  };

  const x11 = firstKnown(optionsRecord.x11, optionsRecord.x11Forwarding, optionsRecord.x11_forwarding);
  if (typeof x11 === "boolean") imported.x11 = x11;

  if (optionsRecord.agentForward === true || optionsRecord.agentForwarding === true) {
    imported.agentForward = true;
    warnings.push("Imported Tabby agent forwarding as metadata; Taomni does not enable SSH agent forwarding at runtime yet.");
  }

  const jump = resolveTabbyJumpHost(profileName, optionsRecord.jumpHost, profileLookup, warnings);
  if (jump) {
    imported.useJump = true;
    imported.jumpHost = jump.host;
    imported.jumpPort = String(jump.port);
    if (jump.username) imported.jumpUser = jump.username;
    warnings.push("Imported Tabby jump-host settings as metadata; Taomni does not use jump hosts at runtime yet.");
  }

  const proxyCommand = cleanText(firstNonEmptyString(optionsRecord.proxyCommand), MAX_OPTION_LENGTH);
  if (proxyCommand) {
    warnings.push(`Skipped Tabby proxy command for "${profileName}" because Taomni session import cannot map proxy commands yet.`);
  }

  const tags = cleanText(firstNonEmptyString(profile.tags, profile.tag), MAX_OPTION_LENGTH);
  if (tags) imported.tags = tags;

  return imported;
}


export function tabbyAuthMethod(
  profileName: string,
  sessionType: string,
  optionsRecord: Record<string, unknown>,
  includeSecrets: boolean,
  warnings: string[],
): { authMethod?: AuthMethod; password?: string; passwordHeldExternally?: boolean } {
  if (sessionType !== "SSH") return {};

  const auth = cleanText(firstString(optionsRecord.auth), 64).toLowerCase();
  const keyPath = firstTabbyPrivateKeyPath(optionsRecord);
  const password = cleanText(firstNonEmptyString(optionsRecord.password), MAX_OPTION_LENGTH);

  if (auth === "agent") {
    warnings.push("Imported Tabby SSH agent authentication, but Taomni SSH agent authentication is not implemented at runtime yet.");
    return { authMethod: "Agent" };
  }

  if (auth === "password" || auth === "keyboardinteractive" || auth === "keyboard-interactive") {
    if (password && includeSecrets) return { authMethod: "Password", password };
    if (password && !includeSecrets) {
      warnings.push(`Skipped Tabby saved password for "${profileName}" because secret import was not enabled.`);
      return { authMethod: "Password" };
    }
    return { authMethod: "Password", passwordHeldExternally: includeSecrets };
  }

  if (keyPath) {
    if (includeSecrets) return { authMethod: { PrivateKey: { key_path: keyPath } } };
    warnings.push(`Skipped Tabby private key path for "${profileName}" because secret import was not enabled.`);
  } else if (auth === "publickey" || auth === "public-key") {
    warnings.push(`Tabby profile "${profileName}" uses public-key auth but has no importable private key path.`);
  }

  if (password) {
    if (includeSecrets) return { authMethod: "Password", password };
    warnings.push(`Skipped Tabby saved password for "${profileName}" because secret import was not enabled.`);
  }

  return { authMethod: "Password" };
}


export function firstTabbyPrivateKeyPath(optionsRecord: Record<string, unknown>): string {
  const candidates = [
    optionsRecord.privateKeys,
    optionsRecord.privateKey,
    optionsRecord.private_key,
    optionsRecord.keyFile,
    optionsRecord.identityFile,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const path = normalizeImportPath(firstString(item));
        if (path) return path;
      }
    } else {
      const path = normalizeImportPath(firstString(candidate));
      if (path) return path;
    }
  }

  return "";
}


export function resolveTabbyJumpHost(
  profileName: string,
  value: unknown,
  profileLookup: Map<string, Record<string, unknown>>,
  warnings: string[],
): { host: string; port: number; username: string | null } | null {
  if (isRecord(value)) {
    const direct = tabbyProfileConnection(value);
    if (direct) return direct;
  }

  const ref = cleanText(firstString(value), MAX_HOST_LENGTH);
  if (!ref) return null;

  const referenced = profileLookup.get(ref);
  if (referenced) {
    const optionsRecord = isRecord(referenced.options) ? referenced.options : {};
    const connection = tabbyProfileConnection(optionsRecord);
    if (connection) return connection;
    warnings.push(`Could not import Tabby jump host "${ref}" for "${profileName}" because the referenced profile has no host.`);
    return null;
  }

  if (ref.toLowerCase().startsWith("ssh:")) {
    warnings.push(`Could not resolve Tabby jump host profile "${ref}" for "${profileName}".`);
    return null;
  }

  const direct = parseJumpTarget(ref);
  if (direct) return direct;
  warnings.push(`Could not import Tabby jump host "${ref}" for "${profileName}".`);
  return null;
}


export function tabbyProfileConnection(value: Record<string, unknown>): { host: string; port: number; username: string | null } | null {
  const host = cleanText(firstNonEmptyString(value.host, value.hostname), MAX_HOST_LENGTH);
  if (!host) return null;
  return {
    host,
    port: sanitizePort(firstKnown(value.port), DEFAULT_PORTS.SSH),
    username: optionalCleanText(firstNonEmptyString(value.user, value.username), MAX_NAME_LENGTH),
  };
}


export function parseJumpTarget(value: string): { host: string; port: number; username: string | null } | null {
  let target = value.trim();
  let username: string | null = null;
  if (target.includes("@")) {
    const parts = target.split("@");
    username = optionalCleanText(parts.slice(0, -1).join("@"), MAX_NAME_LENGTH);
    target = parts[parts.length - 1] ?? "";
  }

  let host = target;
  let port = DEFAULT_PORTS.SSH;
  const portMatch = /^(.+):(\d+)$/.exec(target);
  if (portMatch && !target.includes("]:")) {
    host = portMatch[1];
    port = sanitizePort(portMatch[2], DEFAULT_PORTS.SSH);
  }
  host = cleanText(host.replace(/^\[|\]$/g, ""), MAX_HOST_LENGTH);
  return host ? { host, port, username } : null;
}


export function parseTabbyConfig(
  text: string,
  warnings: string[],
): { profiles: Array<Record<string, unknown>>; groupNames: Map<string, string> } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      const profiles = rawProfiles.filter(isRecord);
      const groupNames = new Map<string, string>();
      if (Array.isArray(parsed.groups)) {
        for (const group of parsed.groups) {
          if (!isRecord(group)) continue;
          const id = cleanText(firstString(group.id), MAX_OPTION_LENGTH);
          const groupName = cleanText(firstString(group.name), MAX_OPTION_LENGTH);
          if (id && groupName) groupNames.set(id, groupName);
        }
      }
      if (profiles.length === 0) warnings.push("No Tabby profiles were found in the selected config.");
      return { profiles, groupNames };
    }
  } catch {
    // Tabby normally uses YAML; JSON imports are accepted as a convenience.
  }

  return parseTabbyYaml(text, warnings);
}


export function parseTabbyYaml(
  text: string,
  warnings: string[],
): { profiles: Array<Record<string, unknown>>; groupNames: Map<string, string> } {
  const profiles: Array<Record<string, unknown>> = [];
  const groupNames = new Map<string, string>();
  let section: "none" | "profiles" | "groups" = "none";
  let current: Record<string, unknown> | null = null;
  let currentOptions: Record<string, unknown> | null = null;
  let profileIndent = -1;
  let optionsIndent = -1;
  let arrayTarget: unknown[] | null = null;
  let arrayIndent = -1;
  let currentGroup: { id: string; name: string } | null = null;
  let groupIndent = -1;

  const flushProfile = () => {
    if (current) profiles.push(current);
    current = null;
    currentOptions = null;
    arrayTarget = null;
    profileIndent = -1;
    optionsIndent = -1;
  };

  const flushGroup = () => {
    if (currentGroup && currentGroup.id && currentGroup.name) {
      groupNames.set(currentGroup.id, currentGroup.name);
    }
    currentGroup = null;
    groupIndent = -1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();

    // Detect a top-level section change (indent === 0, "key:" form).
    if (indent === 0 && /^[A-Za-z][\w-]*:\s*(.*)$/.test(line)) {
      flushProfile();
      flushGroup();
      const key = line.split(":", 1)[0]?.trim() ?? "";
      if (key === "profiles") section = "profiles";
      else if (key === "groups") section = "groups";
      else section = "none";
      continue;
    }

    if (section === "profiles") {
      if (arrayTarget && indent <= arrayIndent) arrayTarget = null;

      if (arrayTarget && line.startsWith("- ") && indent > arrayIndent) {
        arrayTarget.push(parseSimpleScalar(line.slice(2).trim()));
        continue;
      }

      if (line.startsWith("- ") && (!current || indent <= profileIndent)) {
        flushProfile();
        current = { options: {} };
        currentOptions = current.options as Record<string, unknown>;
        profileIndent = indent;
        optionsIndent = -1;
        const rest = line.slice(2).trim();
        if (rest) assignSimpleYamlPair(current, rest);
        continue;
      }

      if (!current || indent <= profileIndent) continue;
      if (currentOptions && optionsIndent >= 0 && indent <= optionsIndent) {
        currentOptions = current.options as Record<string, unknown>;
      }
      if (line === "options:" || line.startsWith("options:")) {
        currentOptions = {};
        current.options = currentOptions;
        optionsIndent = indent;
        continue;
      }

      const target = optionsIndent >= 0 && indent > optionsIndent && currentOptions ? currentOptions : current;
      const emptyKey = yamlEmptyKey(line);
      if (emptyKey) {
        const container = yamlEmptyContainer(emptyKey);
        target[emptyKey] = container;
        if (Array.isArray(container)) {
          arrayTarget = container;
          arrayIndent = indent;
        }
        continue;
      }

      if (optionsIndent >= 0 && indent > optionsIndent && currentOptions) {
        assignSimpleYamlPair(currentOptions, line);
      } else {
        assignSimpleYamlPair(current, line);
      }
      continue;
    }

    if (section === "groups") {
      if (line.startsWith("- ") && (!currentGroup || indent <= groupIndent)) {
        flushGroup();
        currentGroup = { id: "", name: "" };
        groupIndent = indent;
        const rest = line.slice(2).trim();
        if (rest) collectTabbyGroupField(currentGroup, rest);
        continue;
      }
      if (currentGroup && indent > groupIndent) {
        collectTabbyGroupField(currentGroup, line);
      }
    }
  }

  flushProfile();
  flushGroup();

  if (profiles.length === 0) warnings.push("No Tabby profiles were found in the selected config.");
  return { profiles, groupNames };
}


export function collectTabbyGroupField(group: { id: string; name: string }, line: string) {
  const separator = line.indexOf(":");
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (key === "id") group.id = String(parseSimpleScalar(value));
  else if (key === "name") group.name = String(parseSimpleScalar(value));
}


export function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}


export function yamlEmptyKey(line: string): string | null {
  const separator = line.indexOf(":");
  if (separator <= 0) return null;
  const value = line.slice(separator + 1).trim();
  return value ? null : line.slice(0, separator).trim();
}


export function yamlEmptyContainer(key: string): Record<string, unknown> | unknown[] {
  return /^(privateKeys|forwardedPorts|scripts)$/i.test(key) ? [] : {};
}


export function assignSimpleYamlPair(target: Record<string, unknown>, line: string) {
  const separator = line.indexOf(":");
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  target[key] = parseSimpleScalar(value);
}





export function collectWindTermRows(value: unknown, folders: string[], rows: WindTermRow[], depth: number) {
  if (depth > 32) return;
  if (Array.isArray(value)) {
    for (const item of value) collectWindTermRows(item, folders, rows, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  const host = cleanText(firstNonEmptyString(value.host, value.hostname, value.address, value.ip), MAX_HOST_LENGTH);
  const name = cleanText(firstNonEmptyString(value.name, value.title, value.label), MAX_NAME_LENGTH);
  const explicitFolder = cleanText(firstNonEmptyString(value.folder, value.group, value.groupName, value.group_name), MAX_NAME_LENGTH);
  const ownFolder = !host && name ? name : explicitFolder;
  const nextFolders = ownFolder ? [...folders, ownFolder] : folders;

  if (host) {
    rows.push({
      name: name || host,
      protocol: firstNonEmptyString(value.protocol, value.type, value.sessionType, value.session_type),
      host,
      port: firstKnown(value.port, value.sshPort, value.ssh_port),
      username: optionalCleanText(firstNonEmptyString(value.username, value.user, value.login), MAX_NAME_LENGTH),
      folder: explicitFolder ? [...folders, explicitFolder] : folders,
    });
  }

  for (const key of ["children", "sessions", "items", "nodes", "data", "groups"]) {
    if (key in value) collectWindTermRows(value[key], nextFolders, rows, depth + 1);
  }
}

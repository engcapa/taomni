import { readSessionBookmark } from "../../../lib/sessionBookmark";
import { useEffect, useMemo, useState } from "react";
import { alertAppDialog } from "../../../lib/appDialogs";
import { useT } from "../../../lib/i18n";
import type { SessionConfig } from "../../../lib/ipc";
import { getSessionNetworkSettings, type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import { SESSION_ROOT_LABEL, collectFolderPaths, folderOptionLabel, toStoredGroupPath } from "../../../lib/sessionPaths";
import { supportsTerminalAppearanceSessionType } from "../../../lib/sessionTerminalTheme";
import { parseSessionOptions, type TerminalProfile } from "../../../lib/terminalProfile";
import { parseVncViewerOptions, type VncViewerOptions } from "../../../lib/vncOptions";
import { useSessionStore } from "../../../stores/sessionStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { SftpPathMapping } from "../../../types";
import { parseRdpOptions, type RdpOptions } from "../../../types/rdp";
import { parsePathMappings as parsePathMappingsFromOptions } from "../../filebrowser/PathMappingsEditor";
import { ossFormFromOptions, type OssFormState } from "../ObjectStorageSettings";
import {
  DB_PROTOS,
  DEFAULT_PORTS,
  PLANNED_CLIENT_PROTOS,
  extractAuthType,
  extractKeyPath,
  initialTerminalProfileForProto,
  optionBoolean,
  optionString,
  protoToSessionType,
  sessionTypeToProto,
  type Proto,
  type SectionTab,
} from "./sessionPolicy";
import { useDatabaseSessionForm } from "./useDatabaseSessionForm";
import { useLocalShellForm } from "./useLocalShellForm";
import { useMailSessionForm } from "./useMailSessionForm";


export interface UseSessionEditorStateContext {
  session: SessionConfig | undefined;
  initialProto: string | undefined;
  defaultGroupPath: string | null;
}

export function useSessionEditorState(context: UseSessionEditorStateContext) {
  const { session, initialProto, defaultGroupPath } = context;
  const t = useT();
  const { addSession, updateSession, removeSession, createFolderPath, sessions, groups } = useSessionStore();
  const isEdit = !!session;

  const initialOptions = useMemo(() => parseSessionOptions(session?.options_json), [session?.options_json]);
  const initialProtoValue = session
    ? sessionTypeToProto(session.session_type, session.options_json)
    : sessionTypeToProto(initialProto);

  /* --- core fields --- */
  const [proto, setProto] = useState<Proto>(initialProtoValue);
  const [section, setSection] = useState<SectionTab>("advanced");
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(
    String(session?.port ?? DEFAULT_PORTS[initialProtoValue] ?? 22),
  );
  const initialUsername = initialProtoValue === "Mail"
    ? session?.username ?? optionString(initialOptions, "mailEmailAddress", "")
    : session?.username ?? "";
  const [username, setUsername] = useState(initialUsername);
  const [specifyUser, setSpecifyUser] = useState(!!initialUsername || initialProtoValue === "Mail");
  const [groupPath, setGroupPath] = useState(
    toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "",
  );

  /* --- auth --- */
  const [authMethod, setAuthMethod] = useState(
    extractAuthType(session?.auth_method),
  );
  const [authRadio, setAuthRadio] = useState<string>(() => {
    const t = extractAuthType(session?.auth_method);
    if (t === "PrivateKey") return "privatekey";
    if (t === "Agent") return "agent";
    if (t === "None" || t === "Gssapi") return "gssapi";
    return "password";
  });
  const [keyPath, setKeyPath] = useState(
    extractKeyPath(session?.auth_method),
  );
  const [password, setPassword] = useState("");
  const [passwordRef, setPasswordRef] = useState<string>(
    () => optionString(initialOptions, "passwordRef", ""),
  );
  const [saveInVault, setSaveInVault] = useState<boolean>(
    () => !!passwordRef || initialProtoValue === "Mail",
  );
  const vaultState = useVaultStore((s) => s.state);

  /* --- advanced SSH --- */
  const [x11, setX11] = useState(() => optionBoolean(initialOptions, "x11", true));
  const [x11Trusted, setX11Trusted] = useState(() => optionBoolean(initialOptions, "x11Trusted", true));
  const [compression, setCompression] = useState(() => optionBoolean(initialOptions, "compression", false));
  const [startupCmd, setStartupCmd] = useState(() => optionString(initialOptions, "startupCmd", ""));
  const [doNotExit, setDoNotExit] = useState(() => optionBoolean(initialOptions, "doNotExit", true));
  const [remoteEnv, setRemoteEnv] = useState(() => optionString(initialOptions, "remoteEnv", "Interactive shell"));
  const [sshBrowser, setSshBrowser] = useState(() => optionString(initialOptions, "sshBrowser", "SFTP protocol (recommended)"));
  const [usePrivKey, setUsePrivKey] = useState(
    extractAuthType(session?.auth_method) === "PrivateKey",
  );

  const [bookmark, setBookmark] = useState(() => readSessionBookmark(session?.options_json));

  /* --- bookmark --- */
  const [description, setDescription] = useState(() => optionString(initialOptions, "description", ""));
  const [tags, setTags] = useState(() => optionString(initialOptions, "tags", ""));
  /* --- AI safety --- */
  const [disableAiWrite, setDisableAiWrite] = useState(() => optionBoolean(initialOptions, "disableAiWrite", false));

  /* --- vault refresh on mount so the Save in vault checkbox state is correct --- */
  const refreshVault = useVaultStore((s) => s.refresh);
  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  /* --- file session options --- */
  const [fileEmbedInTab, setFileEmbedInTab] = useState(() => optionBoolean(initialOptions, "fileEmbedInTab", true));
  const [fileExtraArgs, setFileExtraArgs] = useState(() => optionString(initialOptions, "fileExtraArgs", ""));
  const databaseForm = useDatabaseSessionForm({
    initialOptions,
    session,
  });

  /* --- proxy session options --- */
  const [proxyKind, setProxyKind] = useState<"http" | "socks5">(() => {
    const v = optionString(initialOptions, "proxyKind", "http");
    return v === "socks5" ? "socks5" : "http";
  });
  const [proxyTestUrl, setProxyTestUrl] = useState(() => optionString(initialOptions, "testUrl", "www.google.com:443"));
  const mailForm = useMailSessionForm({
    initialOptions,
    session,
    initialProtoValue,
  });

  /* --- terminal profile --- */
  const [terminalProfile, setTerminalProfile] = useState<TerminalProfile>(() =>
    initialTerminalProfileForProto(session?.options_json, initialProtoValue),
  );

  /* --- serial client options --- */
  const [serialDevice, setSerialDevice] = useState(() =>
    session?.session_type === "Serial" ? session.host : optionString(initialOptions, "serialDevice", ""),
  );
  const [serialBaud, setSerialBaud] = useState(() =>
    optionString(initialOptions, "serialBaud", "115200"),
  );
  const shellForm = useLocalShellForm({
    session,
    proto,
  });

  /* --- RDP options --- */
  const [rdpOptions, setRdpOptions] = useState<RdpOptions>(() =>
    parseRdpOptions(session?.options_json),
  );

  /* --- VNC production policies --- */
  const [vncSecurityPolicy, setVncSecurityPolicy] = useState<
    "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" | "prefer-off"
  >(() => {
    const value = optionString(initialOptions, "vncSecurityPolicy", "prefer-encryption");
    return value === "require-encryption" || value === "legacy-compatible" || value === "allow-none"
      || value === "prefer-off"
      ? value
      : "prefer-encryption";
  });
  // VNC-CONN-001: RealVNC Options, saved as flat vnc* keys (vncOptions.ts).
  const [vncViewer, setVncViewer] = useState<VncViewerOptions>(() => parseVncViewerOptions(initialOptions));
  const [vncViewOnly, setVncViewOnly] = useState(() => optionBoolean(initialOptions, "vncViewOnly", false));
  const [vncClipboardPolicy, setVncClipboardPolicy] = useState<
    "disabled" | "client-to-server" | "server-to-client" | "bidirectional"
  >(() => {
    const value = optionString(initialOptions, "vncClipboardPolicy", "bidirectional");
    return value === "disabled" || value === "client-to-server" || value === "server-to-client"
      ? value
      : "bidirectional";
  });

  /* --- SFTP path mappings --- */
  const [pathMappings, setPathMappings] = useState<SftpPathMapping[]>(() =>
    parsePathMappingsFromOptions(session?.options_json),
  );

  /* --- object storage (S3 / Azure Blob) --- */
  const [oss, setOss] = useState<OssFormState>(() => ossFormFromOptions(session?.options_json));

  /* --- network settings --- */
  const [networkSettings, setNetworkSettings] = useState<NetworkSettingsValue>(
    () => session ? getSessionNetworkSettings(session.options_json) : { ...getSessionNetworkSettings(null), proxyKind: "app" },
  );

  /* --- test connection --- */
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Footer short status + modal with the full success / error text (errors often overflow the footer). */
  const presentTestOutcome = (ok: boolean, rawMessage: string) => {
    let message = rawMessage.trimEnd();
    if (!message) {
      message = ok ? t("sessionEditor2.testConnection") : t("sessionEditor2.testFailedTitle");
    } else if (!ok && /:\s*$/.test(message)) {
      // e.g. "Presto error (502 Bad Gateway): " with an empty HTTP body
      message = `${message}\n\n${t("sessionEditor2.testEmptyDetail")}`;
    }
    setTestResult({ ok, msg: message });
    void alertAppDialog({
      title: ok ? t("sessionEditor2.testSuccessTitle") : t("sessionEditor2.testFailedTitle"),
      message,
      okLabel: t("sessionEditor2.ok"),
      tone: ok ? "success" : "error",
    });
  };

  /* --- derived --- */
  const needsHost = !["Serial", "File", "Shell", "WSL", "HBaseShell", "S3"].includes(proto);
  const isSSH = ["SSH", "SFTP"].includes(proto);
  const isRdp = proto === "RDP";
  const isDb = DB_PROTOS.includes(proto);
  const isHBase = proto === "HBaseShell";
  const isProxy = proto === "Proxy";
  const isMail = proto === "Mail";
  const isObjectStorage = proto === "S3";
  const isPlannedClient = PLANNED_CLIENT_PROTOS.has(proto);
  const supportsTerminalAppearance = supportsTerminalAppearanceSessionType(protoToSessionType(proto));
  const folderOptions = useMemo(() => {
    const options = new Set<string>([
      SESSION_ROOT_LABEL,
      "User sessions / Production",
      "User sessions / Development",
      "User sessions / Quick & local",
    ]);

    for (const path of collectFolderPaths(sessions, groups)) {
      options.add(folderOptionLabel(path));
    }

    if (groupPath) {
      options.add(folderOptionLabel(groupPath));
    }

    return [...options].sort((a, b) => {
      if (a === SESSION_ROOT_LABEL) return -1;
      if (b === SESSION_ROOT_LABEL) return 1;
      return a.localeCompare(b);
    });
  }, [groupPath, groups, sessions]);
  return {
    bookmark, setBookmark,
    setProto,
    setPort,
    setSection,
    setSpecifyUser,
    setSaveInVault,
    mailForm,
    setTerminalProfile,
    setHost,
    setAuthRadio,
    setAuthMethod,
    setUsePrivKey,
    passwordRef,
    networkSettings,
    supportsTerminalAppearance,
    isMail,
    proto,
    shellForm,
    serialDevice,
    serialBaud,
    rdpOptions,
    vncSecurityPolicy,
    vncViewOnly,
    vncClipboardPolicy,
    vncViewer,
    isDb,
    databaseForm,
    isProxy,
    proxyKind,
    proxyTestUrl,
    oss,
    isHBase,
    terminalProfile,
    x11,
    x11Trusted,
    compression,
    startupCmd,
    description,
    tags,
    doNotExit,
    disableAiWrite,
    remoteEnv,
    sshBrowser,
    usePrivKey,
    fileEmbedInTab,
    fileExtraArgs,
    pathMappings,
    authMethod,
    keyPath,
    name,
    t,
    username,
    host,
    port,
    groupPath,
    needsHost,
    saveInVault,
    password,
    isSSH,
    specifyUser,
    setSaveError,
    setPasswordRef,
    setPassword,
    setNetworkSettings,
    setOss,
    isEdit,
    updateSession,
    addSession,
    setTestResult,
    setName,
    setUsername,
    setGroupPath,
    setKeyPath,
    setX11,
    setX11Trusted,
    setCompression,
    setStartupCmd,
    setDoNotExit,
    setDisableAiWrite,
    setRemoteEnv,
    setSshBrowser,
    setDescription,
    setTags,
    setFileEmbedInTab,
    setFileExtraArgs,
    setSerialDevice,
    setSerialBaud,
    setRdpOptions,
    setVncSecurityPolicy,
    setVncViewOnly,
    setVncViewer,
    setVncClipboardPolicy,
    setPathMappings,
    createFolderPath,
    removeSession,
    presentTestOutcome,
    setTesting,
    isObjectStorage,
    isRdp,
    section,
    testing,
    vaultState,
    isPlannedClient,
    authRadio,
    setProxyKind,
    setProxyTestUrl,
    sessions,
    folderOptions,
    testResult,
    saveError,
  };
}

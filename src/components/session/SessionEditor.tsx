import { useEffect, useMemo, useState } from "react";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useModalShortcuts, getShortcutSuffixes } from "../../hooks/useModalShortcuts";
import {
  X,
  Terminal as TerminalIcon,
  Monitor,
  Folder,
  Wifi,
  Bookmark,
  Shield,
  FlaskConical,
  FileText,
  Globe,
  Cloud,
  Server,
  ChevronDown,
  Search,
  FolderPlus,
  Save,
  RotateCcw,
  Network,
  HelpCircle,
  Database,
  Info,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import { ensureVaultReady } from "../../lib/vaultGate";
import {
  selectFilePath,
  selectFolderPath,
  selectPrivateKeyFile,
  testSshConnection,
  testProxyConnection,
  dbTestConnection,
  hbaseTestConnection,
  hbaseParseSiteXml,
  hbaseParseKeytabPrincipal,
  vaultPut,
  isVaultReference,
  isVaultLockedError,
  listWslDistros,
  type WslDistro,
} from "../../lib/ipc";
import type { DbConnectInfo, HBaseConnectInfo } from "../../types";
import { getAppPlatform } from "../../lib/runtime";
import {
  getSessionNetworkSettings,
  ipKindToLabel,
  ipLabelToKind,
  proxyKindToLabel,
  proxyLabelToKind,
  toNetworkSettingsPayload,
  type NetworkSettings as NetworkSettingsValue,
} from "../../lib/networkSettings";
import { parseUserHostPort } from "../../lib/quickConnect";
import {
  SESSION_ROOT_LABEL,
  collectFolderPaths,
  folderOptionLabel,
  normalizeGroupPath,
  toStoredGroupPath,
} from "../../lib/sessionPaths";
import { promptAppDialog } from "../../lib/appDialogs";
import type { SessionConfig, AuthMethod } from "../../lib/ipc";
import {
  getSessionTerminalProfile,
  loadGlobalTerminalProfile,
  parseSessionOptions,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import {
  buildWslLaunchArgs,
  parseWslOptions,
  serializeWslOptions,
  type WslOptions,
} from "../../types/wsl";
import {
  parseRdpOptions,
  serializeRdpOptions,
  type RdpOptions,
} from "../../types/rdp";
import { RdpOptionsForm } from "./forms/RdpOptionsForm";
import {
  ObjectStorageSettings,
  ossFormFromOptions,
  type OssFormState,
} from "./ObjectStorageSettings";
import { engineForProvider } from "../../types/objectStorage";
import { WslOptionsForm } from "./forms/WslOptionsForm";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";
import { useT, type TranslateFn } from "../../lib/i18n";
import {
  PathMappingsEditor,
  parsePathMappings as parsePathMappingsFromOptions,
} from "../filebrowser/PathMappingsEditor";
import type { SftpPathMapping } from "../../types";

/* ------------------------------------------------------------------ */
/*  Local types                                                        */
/* ------------------------------------------------------------------ */

type Proto =
  | "SSH" | "Telnet" | "Rlogin" | "RDP" | "VNC" | "FTP" | "SFTP"
  | "Serial" | "File" | "Shell" | "Browser" | "Mosh" | "S3" | "WSL"
  | "MySQL" | "PostgreSQL" | "ClickHouse" | "Presto" | "Redis" | "HBaseShell"
  | "Proxy";

type SectionTab = "advanced" | "terminal" | "network" | "bookmark" | "rdp" | "database" | "mappings" | "proxy" | "objectstorage";

const PROTOS: { id: Proto; icon: React.ReactNode; color: string }[] = [
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
  { id: "ClickHouse", icon: <Database className="w-7 h-7" />, color: "#e6a817" },
  { id: "Presto",     icon: <Database className="w-7 h-7" />, color: "#5a4fcf" },
  { id: "Redis",      icon: <Database className="w-7 h-7" />, color: "#d82c20" },
  { id: "HBaseShell", icon: <Database className="w-7 h-7" />, color: "#1d7f8c" },
  { id: "Proxy",     icon: <Network className="w-7 h-7" />, color: "#6b7280" },
];

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22, Telnet: 23, Rlogin: 513, RDP: 3389, VNC: 5900,
  FTP: 21, SFTP: 22, Serial: 0, File: 0, Shell: 0,
  Browser: 0, Mosh: 60001, S3: 443, WSL: 0,
  MySQL: 3306, PostgreSQL: 5432, ClickHouse: 9000, Presto: 8080, Redis: 6379,
  HBaseShell: 8080, Proxy: 3128,
};

const DB_PROTOS: Proto[] = ["MySQL", "PostgreSQL", "ClickHouse", "Presto", "Redis"];

/** Map UI proto to the backend session_type string. Object storage ("S3"
 * proto) is resolved to "S3" vs "AzureBlob" by the caller based on the
 * selected provider. */
function protoToSessionType(p: Proto): string {
  const map: Partial<Record<Proto, string>> = {
    Rlogin: "Telnet", Shell: "LocalShell",
    Browser: "LocalShell", Mosh: "SSH", WSL: "LocalShell",
  };
  return map[p] ?? p;
}

function sessionTypeToProto(type: string | undefined, optionsJson?: string | null): Proto {
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

function extractKeyPath(auth: AuthMethod | undefined): string {
  if (auth && typeof auth === "object" && "PrivateKey" in auth) {
    return auth.PrivateKey.key_path;
  }
  return "";
}

function extractAuthType(
  auth: AuthMethod | undefined,
): "Password" | "PrivateKey" | "Agent" | "None" {
  if (!auth) return "Password";
  if (typeof auth === "string") return auth as "Password" | "Agent" | "None";
  if (typeof auth === "object" && "PrivateKey" in auth) return "PrivateKey";
  return "Password";
}

function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof options[key] === "boolean" ? options[key] : fallback;
}

function optionString(options: Record<string, unknown>, key: string, fallback: string): string {
  return typeof options[key] === "string" ? options[key] : fallback;
}

function stripDeprecatedCwdOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.followPath;
  delete next.osc7AutoInject;
  return next;
}

/* ------------------------------------------------------------------ */
/*  Tiny local UI primitives (match prototype)                         */
/* ------------------------------------------------------------------ */

function Checkbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      className="taomni-checkbox"
      data-checked={checked}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.checked)}
    />
  );
}

function Radio({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: () => void;
}) {
  return (
    <input
      type="radio"
      className="taomni-radio"
      checked={checked}
      onChange={onChange}
    />
  );
}

function Select({
  value,
  options,
  onChange,
  className = "",
}: {
  value: string;
  options: string[];
  onChange?: (v: string) => void;
  className?: string;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        className={`taomni-input pr-6 appearance-none ${className || "w-[260px]"}`}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--taomni-text-muted)]" />
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="col-span-3 text-[12px] text-right pt-1 text-[var(--taomni-text)]">
        {label}
      </div>
      <div className="col-span-9 flex items-center flex-wrap gap-1">
        {children}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-panels                                                         */
/* ------------------------------------------------------------------ */

function AdvancedSshSettings({
  t,
  x11, setX11,
  x11Trusted, setX11Trusted,
  compression, setCompression,
  startupCmd, setStartupCmd,
  doNotExit, setDoNotExit,
  remoteEnv, setRemoteEnv,
  sshBrowser, setSshBrowser,
  authRadio, setAuthRadio,
  password, setPassword,
  passwordRef,
  clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  usePrivKey, setUsePrivKey,
  keyPath, setKeyPath,
  onBrowseKey,
}: {
  t: TranslateFn;
  x11: boolean; setX11: (v: boolean) => void;
  x11Trusted: boolean; setX11Trusted: (v: boolean) => void;
  compression: boolean; setCompression: (v: boolean) => void;
  startupCmd: string; setStartupCmd: (v: string) => void;
  doNotExit: boolean; setDoNotExit: (v: boolean) => void;
  remoteEnv: string; setRemoteEnv: (v: string) => void;
  sshBrowser: string; setSshBrowser: (v: string) => void;
  authRadio: string; setAuthRadio: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string;
  clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  usePrivKey: boolean; setUsePrivKey: (v: boolean) => void;
  keyPath: string; setKeyPath: (v: string) => void;
  onBrowseKey: () => void;
}) {
  return (
    <div data-testid="advanced-ssh-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label={t("sessionEditor2.fieldX11")}>
        <label className="flex items-center gap-1.5">
          <Checkbox checked={x11} onChange={setX11} />
          {t("sessionEditor2.enable")}
        </label>
        <label className={`flex items-center gap-1.5 ml-3 ${x11 ? "" : "opacity-50"}`} title={t("sessionEditor2.x11TrustedHint")}>
          <Checkbox checked={x11Trusted} onChange={setX11Trusted} disabled={!x11} />
          {t("sessionEditor2.x11Trusted")}
        </label>
      </Field>

      <Field label={t("sessionEditor2.fieldCompression")}>
        <label className="flex items-center gap-1.5">
          <Checkbox checked={compression} onChange={setCompression} />
          {t("sessionEditor2.compressionLabel")}
        </label>
      </Field>

      <Field label={t("sessionEditor2.fieldRemoteEnvironment")}>
        <Select
          value={remoteEnv}
          options={[
            t("sessionEditor2.remoteEnvInteractive"),
            t("sessionEditor2.remoteEnvLxde"),
            t("sessionEditor2.remoteEnvXfce"),
            t("sessionEditor2.remoteEnvGnome"),
            t("sessionEditor2.remoteEnvKde"),
            t("sessionEditor2.remoteEnvAwesome"),
            t("sessionEditor2.remoteEnvCustom"),
          ]}
          onChange={setRemoteEnv}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldExecuteCommand")}>
        <input
          className="taomni-input flex-1"
          placeholder={t("sessionEditor2.executeCommandPlaceholder")}
          value={startupCmd}
          aria-label={t("sessionEditor2.executeCommandAria")}
          onChange={(e) => setStartupCmd(e.target.value)}
        />
        <label className="ml-2 flex items-center gap-1.5">
          <Checkbox checked={doNotExit} onChange={setDoNotExit} />
          {t("sessionEditor2.doNotExit")}
        </label>
      </Field>

      <Field label={t("sessionEditor2.fieldSshBrowserType")}>
        <Select
          value={sshBrowser}
          options={[
            t("sessionEditor2.sshBrowserSftp"),
            t("sessionEditor2.sshBrowserScpSpeed"),
            t("sessionEditor2.sshBrowserScpCompat"),
            t("sessionEditor2.sshBrowserDisabled"),
          ]}
          onChange={setSshBrowser}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldAuthentication")}>
        <div className="flex flex-col gap-1.5 w-full">
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ["password", t("sessionEditor2.authPasswordKbi")],
                ["privatekey", t("sessionEditor2.authPrivateKey")],
                ["agent", t("sessionEditor2.authAgent")],
                ["gssapi", t("sessionEditor2.authGssapi")],
              ] as const
            ).map(([val, lbl]) => (
              <label key={val} className="flex items-center gap-1.5 cursor-pointer">
                <Radio
                  checked={authRadio === val}
                  onChange={() => setAuthRadio(val)}
                />
                {lbl}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 pl-1 flex-wrap">
            <span className="text-[var(--taomni-text-muted)]">{t("sessionEditor2.passwordLabel")}</span>
            <input
              className="taomni-input w-44"
              type="password"
              value={password}
              aria-label={t("sessionEditor2.passwordAria")}
              placeholder={passwordRef ? t("sessionEditor2.passwordPlaceholderSaved") : ""}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordRef) clearPasswordRef();
              }}
            />
            <label
              className="flex items-center gap-1 text-[11px] cursor-pointer"
              title={
                vaultState === "empty"
                  ? t("sessionEditor2.saveInVaultTitleSetup")
                  : t("sessionEditor2.saveInVaultTitleDefault")
              }
            >
              <input
                type="checkbox"
                className="taomni-checkbox"
                data-testid="session-save-in-vault"
                checked={saveInVault}
                onChange={(e) => setSaveInVault(e.target.checked)}
              />
              {t("sessionEditor2.saveInVault")}
            </label>
            <span className="taomni-pill">
              <Shield className="w-3 h-3" /> {t("sessionEditor2.encryptedPill")}
            </span>
          </div>
        </div>
      </Field>

      <Field label={t("sessionEditor2.fieldPrivateKey")}>
        <Checkbox checked={usePrivKey} onChange={setUsePrivKey} />
        <input
          className="taomni-input flex-1 ml-2"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          disabled={!usePrivKey}
          aria-label={t("sessionEditor2.privateKeyAria")}
          placeholder={t("sessionEditor2.privateKeyPlaceholder")}
        />
        <button className="taomni-btn ml-1" disabled={!usePrivKey} onClick={onBrowseKey} type="button">
          {t("sessionEditor2.browse")}
        </button>
        <button className="taomni-btn ml-1" disabled type="button" title={t("sessionEditor2.generateTitle")}>
          {t("sessionEditor2.generate")}
        </button>
      </Field>

      <Field label={t("sessionEditor2.fieldExpertSsh")}>
        <button className="taomni-btn" type="button" disabled title={t("sessionEditor2.expertTitle")}>{t("sessionEditor2.openExpertSettings")}</button>
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.expertDesc")}
        </span>
      </Field>
    </div>
  );
}

function TerminalSettings({
  profile,
  onProfileChange,
}: {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
}) {
  return (
    <div data-testid="terminal-settings" className="text-[12px]">
      <TerminalAppearanceSettings
        profile={profile}
        onProfileChange={onProfileChange}
        showCustomColors
      />
    </div>
  );
}

/** Proxy selector + (HTTP/SOCKS5) proxy fields or the SSH jump-host section.
 *  Shared by the SSH Network tab and the database Network tab so both speak
 *  the same `NetworkSettings` shape and persistence path. */
function ProxyJumpFields({
  t,
  value,
  onChange,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const proxy = proxyKindToLabel(value.proxyKind);
  const isJump = value.proxyKind === "ssh-tunnel";
  const isHttpOrSocks = value.proxyKind === "http" || value.proxyKind === "socks5";
  const proxyManual = value.proxySessionId?.trim() === "";
  const jumpManual = value.jumpSessionId.trim() === "";
  return (
    <>
      <Field label={t("sessionEditor2.fieldProxy")}>
        <Select
          value={proxy}
          options={[
            t("sessionEditor2.proxyNone"),
            t("sessionEditor2.proxyHttp"),
            t("sessionEditor2.proxySocks5"),
            t("sessionEditor2.proxyLocalSshTunnel"),
            t("sessionEditor2.proxySystem"),
          ]}
          onChange={(label) => patch({ proxyKind: proxyLabelToKind(label) })}
        />
      </Field>

      {isJump && (
        <>
          <Field label={t("sessionEditor2.fieldJumpVia")}>
            <select
              className="taomni-input w-72"
              value={value.jumpSessionId}
              aria-label={t("sessionEditor2.jumpViaAria")}
              onChange={(e) => patch({ jumpSessionId: e.target.value })}
            >
              <option value="">{t("sessionEditor2.jumpManualOption")}</option>
              {sshSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host}:{s.port})
                </option>
              ))}
            </select>
          </Field>

          {jumpManual && (
            <>
              <Field label={t("sessionEditor2.fieldJumpHost")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.jumpHostPlaceholder")}
                  value={value.jumpHost}
                  aria-label={t("sessionEditor2.jumpHostAria")}
                  onChange={(e) => patch({ jumpHost: e.target.value })}
                />
                <span className="text-[var(--taomni-text-muted)] ml-2">{t("sessionEditor2.portLabel")}</span>
                <input
                  className="taomni-input w-16 ml-1"
                  placeholder="22"
                  value={value.jumpPort}
                  aria-label={t("sessionEditor2.jumpPortAria")}
                  onChange={(e) => patch({ jumpPort: e.target.value })}
                />
              </Field>

              <Field label={t("sessionEditor2.fieldJumpUser")}>
                <input
                  className="taomni-input w-32"
                  placeholder={t("sessionEditor2.jumpUserPlaceholder")}
                  value={value.jumpUser}
                  aria-label={t("sessionEditor2.jumpUserAria")}
                  onChange={(e) => patch({ jumpUser: e.target.value })}
                />
                <select
                  className="taomni-input w-28 ml-2"
                  value={value.jumpAuthKind}
                  aria-label={t("sessionEditor2.jumpAuthAria")}
                  onChange={(e) => patch({ jumpAuthKind: e.target.value === "PrivateKey" ? "PrivateKey" : "Password" })}
                >
                  <option value="Password">{t("sessionEditor2.jumpAuthPassword")}</option>
                  <option value="PrivateKey">{t("sessionEditor2.jumpAuthKey")}</option>
                </select>
              </Field>

              {value.jumpAuthKind === "Password" ? (
                <Field label={t("sessionEditor2.fieldJumpPassword")}>
                  <input
                    className="taomni-input w-64"
                    type="password"
                    placeholder={t("sessionEditor2.jumpPasswordPlaceholder")}
                    value={value.jumpPassword}
                    aria-label={t("sessionEditor2.jumpPasswordAria")}
                    onChange={(e) => patch({ jumpPassword: e.target.value })}
                  />
                  <label className="ml-2 flex items-center gap-1.5">
                    <Checkbox checked={value.jumpSaveAuth} onChange={(v) => patch({ jumpSaveAuth: v })} /> {t("sessionEditor2.proxySaveInVault")}
                  </label>
                </Field>
              ) : (
                <Field label={t("sessionEditor2.fieldJumpKey")}>
                  <input
                    className="taomni-input w-72"
                    placeholder={t("sessionEditor2.jumpKeyPlaceholder")}
                    value={value.jumpKeyPath}
                    aria-label={t("sessionEditor2.jumpKeyAria")}
                    onChange={(e) => patch({ jumpKeyPath: e.target.value })}
                  />
                </Field>
              )}
            </>
          )}
        </>
      )}

      {isHttpOrSocks && (
        <>
          {proxySessions.length > 0 && (
            <Field label={t("sessionEditor2.proxyViaSession")}>
              <select
                className="taomni-input w-72"
                value={value.proxySessionId || ""}
                onChange={(e) => patch({ proxySessionId: e.target.value })}
              >
                <option value="">{t("sessionEditor2.proxyManualOption")}</option>
                {proxySessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host}:{s.port})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {proxyManual && (
            <>
              <Field label={t("sessionEditor2.fieldProxyHost")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.proxyHostPlaceholder")}
                  value={value.proxyHost}
                  aria-label={t("sessionEditor2.proxyHostAria")}
                  onChange={(e) => patch({ proxyHost: e.target.value })}
                />
                <span className="text-[var(--taomni-text-muted)] ml-2">{t("sessionEditor2.portLabel")}</span>
                <input
                  className="taomni-input w-16 ml-1"
                  placeholder={t("sessionEditor2.proxyPortPlaceholder")}
                  value={value.proxyPort}
                  aria-label={t("sessionEditor2.proxyPortAria")}
                  onChange={(e) => patch({ proxyPort: e.target.value })}
                />
              </Field>

              <Field label={t("sessionEditor2.fieldProxyAuth")}>
                <input
                  className="taomni-input w-32"
                  placeholder={t("sessionEditor2.proxyUserPlaceholder")}
                  value={value.proxyUser}
                  aria-label={t("sessionEditor2.proxyUserAria")}
                  onChange={(e) => patch({ proxyUser: e.target.value })}
                />
                <input
                  className="taomni-input w-40 ml-1"
                  type="password"
                  placeholder={t("sessionEditor2.proxyPassPlaceholder")}
                  value={value.proxyPass}
                  aria-label={t("sessionEditor2.proxyPassAria")}
                  onChange={(e) => patch({ proxyPass: e.target.value })}
                />
                <label className="ml-2 flex items-center gap-1.5">
                  <Checkbox checked={value.proxySaveAuth} onChange={(v) => patch({ proxySaveAuth: v })} /> {t("sessionEditor2.proxySaveInVault")}
                </label>
              </Field>
              {onSaveAsProxySession && (
                <Field label="">
                  <button
                    className="taomni-btn flex items-center gap-1.5"
                    type="button"
                    onClick={onSaveAsProxySession}
                    title={t("sessionEditor2.saveAsProxySessionTitle")}
                  >
                    <Save className="w-3.5 h-3.5" />
                    {t("sessionEditor2.saveAsProxySession")}
                  </button>
                </Field>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Network tab for database sessions: proxy + SSH jump host only (no
 *  keep-alive / TCP / local-forward rows, which are SSH-terminal specific). */
function DbNetworkSettings({
  t,
  value,
  onChange,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  return (
    <div data-testid="db-network-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <ProxyJumpFields t={t} value={value} onChange={onChange} sshSessions={sshSessions} proxySessions={proxySessions} onSaveAsProxySession={onSaveAsProxySession} />
    </div>
  );
}

function NetworkSettings({
  t,
  value,
  onChange,
  sessionConfigId,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  /** When set, the Network tab subscribes to runtime forward errors
   *  for this saved session and renders the latest failure inline next
   *  to the offending row. */
  sessionConfigId?: string;
  /** Saved SSH sessions selectable as a jump host (current session excluded). */
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  const [newFwdLocal, setNewFwdLocal] = useState("");
  const [newFwdRemote, setNewFwdRemote] = useState("");
  const [newFwdDesc, setNewFwdDesc] = useState("");
  // Per-row latest forward error, keyed by `${local}->${remote}`.
  const [forwardErrors, setForwardErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sessionConfigId) return;
    const onErr = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        sessionConfigId: string;
        local: string;
        remote: string;
        message: string;
      }>).detail;
      if (!detail || detail.sessionConfigId !== sessionConfigId) return;
      setForwardErrors((m) => ({
        ...m,
        [`${detail.local}->${detail.remote}`]: detail.message,
      }));
    };
    window.addEventListener("taomni:forward-error", onErr as EventListener);
    return () => window.removeEventListener("taomni:forward-error", onErr as EventListener);
  }, [sessionConfigId]);

  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const keepAlive = value.keepAlive;
  const keepAliveInterval = value.keepAliveIntervalSecs;
  const tcpNodelay = value.tcpNodelay;
  const disableNagle = value.disableNagle;
  const ipVersion = ipKindToLabel(value.ipVersion);
  const forwards = value.localForwards;

  const setKeepAlive = (v: boolean) => patch({ keepAlive: v });
  const setKeepAliveInterval = (v: string) => patch({ keepAliveIntervalSecs: v });
  const setIpVersion = (label: string) => patch({ ipVersion: ipLabelToKind(label) });
  const setForwards = (
    updater: (items: NetworkSettingsValue["localForwards"]) => NetworkSettingsValue["localForwards"],
  ) => patch({ localForwards: updater(value.localForwards) });

  const addForward = () => {
    if (!newFwdLocal.trim() || !newFwdRemote.trim()) return;
    setForwards((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        local: newFwdLocal.trim(),
        remote: newFwdRemote.trim(),
        desc: newFwdDesc.trim(),
      },
    ]);
    setNewFwdLocal("");
    setNewFwdRemote("");
    setNewFwdDesc("");
  };

  return (
    <div data-testid="network-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <ProxyJumpFields t={t} value={value} onChange={onChange} sshSessions={sshSessions} proxySessions={proxySessions} onSaveAsProxySession={onSaveAsProxySession} />

      <Field label={t("sessionEditor2.fieldKeepAlive")}>
        <label className="flex items-center gap-1.5">
          <Checkbox checked={keepAlive} onChange={setKeepAlive} />
          {t("sessionEditor2.keepAliveSend")}
        </label>
        <input
          className="taomni-input w-16 ml-1"
          value={keepAliveInterval}
          aria-label={t("sessionEditor2.keepAliveAria")}
          onChange={(e) => setKeepAliveInterval(e.target.value)}
        />
        <span className="ml-1">{t("sessionEditor2.keepAliveSuffix")}</span>
      </Field>

      <Field label={t("sessionEditor2.fieldTcpOptions")}>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={tcpNodelay}
            onChange={(v) => patch({ tcpNodelay: v, disableNagle: v })}
          /> {t("sessionEditor2.tcpNodelay")}
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox
            checked={disableNagle}
            onChange={(v) => patch({ disableNagle: v, tcpNodelay: v })}
          /> {t("sessionEditor2.disableNagle")}
        </label>
      </Field>

      <Field label={t("sessionEditor2.fieldIpVersion")}>
        <Select
          value={ipVersion}
          options={[t("sessionEditor2.ipAuto"), t("sessionEditor2.ipForceIpv4"), t("sessionEditor2.ipForceIpv6")]}
          onChange={setIpVersion}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldLocalForwarding")}>
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-1.5 text-[var(--taomni-text-muted)]">
            <span className="w-32">{t("sessionEditor2.forwardLocalHeader")}</span>
            <span className="w-32">{t("sessionEditor2.forwardRemoteHeader")}</span>
            <span>{t("sessionEditor2.forwardDescHeader")}</span>
          </div>
          {forwards.map((forward) => {
            const errKey = `${forward.local.trim()}->${forward.remote.trim()}`;
            const rowError = forwardErrors[errKey];
            return (
              <div key={forward.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <input
                    className="taomni-input w-32"
                    value={forward.local}
                    aria-label={t("sessionEditor2.forwardLocalAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, local: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="taomni-input w-40"
                    value={forward.remote}
                    aria-label={t("sessionEditor2.forwardRemoteAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, remote: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="taomni-input flex-1"
                    value={forward.desc}
                    aria-label={t("sessionEditor2.forwardDescAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, desc: e.target.value } : item),
                      )
                    }
                  />
                  <button className="taomni-btn" type="button" onClick={() => setForwards((items) => items.filter((item) => item.id !== forward.id))}>
                    {t("sessionEditor2.forwardRemove")}
                  </button>
                </div>
                {rowError && (
                  <div
                    className="text-[11px] text-red-400 ml-[2px]"
                    role="status"
                    data-testid={`forward-row-error-${forward.id}`}
                  >
                    {rowError}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <input className="taomni-input w-32" placeholder={t("sessionEditor2.forwardLocalPlaceholder")} value={newFwdLocal} aria-label={t("sessionEditor2.forwardLocalNewAria")} onChange={(e) => setNewFwdLocal(e.target.value)} />
            <input className="taomni-input w-40" placeholder={t("sessionEditor2.forwardRemotePlaceholder")} value={newFwdRemote} aria-label={t("sessionEditor2.forwardRemoteNewAria")} onChange={(e) => setNewFwdRemote(e.target.value)} />
            <input className="taomni-input flex-1" placeholder={t("sessionEditor2.forwardDescPlaceholder")} value={newFwdDesc} aria-label={t("sessionEditor2.forwardDescNewAria")} onChange={(e) => setNewFwdDesc(e.target.value)} />
            <button className="taomni-btn" type="button" onClick={addForward} disabled={!newFwdLocal.trim() || !newFwdRemote.trim()}>{t("sessionEditor2.forwardAdd")}</button>
          </div>
        </div>
      </Field>
    </div>
  );
}

function BookmarkSettings({
  t,
  name, setName,
  groupPath, setGroupPath,
  folderOptions,
  description, setDescription,
  tags, setTags,
  proto,
  onNewFolder,
  fileEmbedInTab, setFileEmbedInTab,
  fileExtraArgs, setFileExtraArgs,
  disableAiWrite, setDisableAiWrite,
}: {
  t: TranslateFn;
  name: string; setName: (v: string) => void;
  groupPath: string; setGroupPath: (v: string) => void;
  folderOptions: string[];
  description: string; setDescription: (v: string) => void;
  tags: string; setTags: (v: string) => void;
  proto: Proto;
  onNewFolder: () => void;
  fileEmbedInTab: boolean; setFileEmbedInTab: (v: boolean) => void;
  fileExtraArgs: string; setFileExtraArgs: (v: string) => void;
  disableAiWrite: boolean; setDisableAiWrite: (v: boolean) => void;
}) {
  const [bgImage, setBgImage] = useState("");
  const [bgOpacity, setBgOpacity] = useState("35%");
  const [autoConnect, setAutoConnect] = useState(true);
  const [openNewWindow, setOpenNewWindow] = useState(false);
  const [reconnect, setReconnect] = useState(true);
  const [shortcut, setShortcut] = useState("");

  const handleBrowseBgImage = async () => {
    try {
      const selected = await selectFilePath(bgImage || undefined);
      if (selected) setBgImage(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  return (
    <div data-testid="bookmark-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label={t("sessionEditor2.fieldSessionName")}>
        <input
          data-testid="session-name"
          className="taomni-input w-72"
          value={name}
          aria-label={t("sessionEditor2.sessionNameAria")}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">{t("sessionEditor2.sessionNameHint")}</span>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionFolder")}>
        <Select
          value={groupPath || "User sessions"}
          className="w-[260px]"
          options={folderOptions}
          onChange={(value) => setGroupPath(value === "User sessions" ? "" : value)}
        />
        <button className="taomni-btn ml-2 flex items-center gap-1" type="button" onClick={onNewFolder}>
          <FolderPlus className="w-3 h-3" /> {t("sessionEditor2.newFolderBtn")}
        </button>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionIcon")}>
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded border"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-input-bg)" }}
        >
          <TerminalIcon className="w-4 h-4" style={{ color: "#2b5d8b" }} />
          {proto.toLowerCase()}
        </span>
        <button className="taomni-btn ml-2" type="button" disabled title={t("sessionEditor2.customIconTitle")}>{t("sessionEditor2.customIconChange")}</button>
      </Field>

      <Field label={t("sessionEditor2.fieldBackgroundImage")}>
        <input
          className="taomni-input flex-1"
          placeholder={t("sessionEditor2.backgroundImagePlaceholder")}
          value={bgImage}
          aria-label={t("sessionEditor2.backgroundImageAria")}
          onChange={(e) => setBgImage(e.target.value)}
        />
        <button
          className="taomni-btn ml-1"
          type="button"
          title={t("sessionEditor2.backgroundImageTitle")}
          onClick={handleBrowseBgImage}
        >
          {t("sessionEditor2.backgroundImageBrowse")}
        </button>
        <span className="ml-2 text-[var(--taomni-text-muted)]">{t("sessionEditor2.backgroundImageOpacity")}</span>
        <input
          className="taomni-input w-16 ml-1"
          value={bgOpacity}
          aria-label={t("sessionEditor2.backgroundOpacityAria")}
          onChange={(e) => setBgOpacity(e.target.value)}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldDescriptionNotes")}>
        <textarea
          className="taomni-input flex-1"
          style={{ height: 56, padding: 6 }}
          value={description}
          aria-label={t("sessionEditor2.descriptionAria")}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("sessionEditor2.descriptionPlaceholder")}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldTags")}>
        <input
          className="taomni-input flex-1"
          value={tags}
          aria-label={t("sessionEditor2.tagsAria")}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("sessionEditor2.tagsPlaceholder")}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldAiSafety")}>
        <label className="flex items-center gap-1.5" data-testid="disable-ai-write-toggle">
          <Checkbox checked={disableAiWrite} onChange={setDisableAiWrite} />
          {t("sessionEditor2.disableAiWriteLabel")}
        </label>
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.disableAiWriteHint")}
        </span>
      </Field>

      {proto === "File" && (
        <>
          <Field label={t("sessionEditor2.fieldFileOptions")}>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={fileEmbedInTab} onChange={setFileEmbedInTab} />
              {t("sessionEditor2.fileEmbedInTab")}
            </label>
          </Field>
          <Field label={t("sessionEditor2.fieldAdditionalParameters")}>
            <input
              className="taomni-input flex-1"
              value={fileExtraArgs}
              aria-label={t("sessionEditor2.additionalParametersAria")}
              onChange={(e) => setFileExtraArgs(e.target.value)}
              placeholder={t("sessionEditor2.additionalParametersPlaceholder")}
            />
          </Field>
        </>
      )}

      {proto !== "File" && (
        <Field label={t("sessionEditor2.fieldStartupBehavior")}>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={autoConnect} onChange={setAutoConnect} />
            {t("sessionEditor2.autoConnect")}
          </label>
          <label className="ml-3 flex items-center gap-1.5">
            <Checkbox checked={openNewWindow} onChange={setOpenNewWindow} />
            {t("sessionEditor2.openNewWindow")}
          </label>
          <label className="ml-3 flex items-center gap-1.5">
            <Checkbox checked={reconnect} onChange={setReconnect} />
            {t("sessionEditor2.reconnectOnDisconnect")}
          </label>
        </Field>
      )}

      <Field label={t("sessionEditor2.fieldKeyboardShortcut")}>
        <input
          className="taomni-input w-40"
          value={shortcut}
          aria-label={t("sessionEditor2.keyboardShortcutAria")}
          onChange={(e) => setShortcut(e.target.value)}
          placeholder={t("sessionEditor2.keyboardShortcutPlaceholder")}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.keyboardShortcutHint")}
        </span>
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Database settings sub-form                                         */
/* ------------------------------------------------------------------ */

function DatabaseSettings({
  proto,
  username, setUsername,
  password, setPassword,
  passwordRef, clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  catalog, setCatalog,
  database, setDatabase,
  ssl, setSsl,
  timeoutSecs, setTimeoutSecs,
  httpPort, setHttpPort,
  chProtocol, setChProtocol,
  redisDbIndex, setRedisDbIndex,
}: {
  proto: Proto;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string; clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  catalog: string; setCatalog: (v: string) => void;
  database: string; setDatabase: (v: string) => void;
  ssl: boolean; setSsl: (v: boolean) => void;
  timeoutSecs: string; setTimeoutSecs: (v: string) => void;
  httpPort: string; setHttpPort: (v: string) => void;
  chProtocol: string; setChProtocol: (v: string) => void;
  redisDbIndex: string; setRedisDbIndex: (v: string) => void;
}) {
  const isRedis = proto === "Redis";
  const isClickHouse = proto === "ClickHouse";
  const isPresto = proto === "Presto";
  return (
    <div data-testid="database-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Username">
        <input
          className="taomni-input w-64"
          value={username}
          aria-label="Database username"
          placeholder={isRedis ? "(optional — ACL user)" : "database user"}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>

      <Field label="Password">
          <input
            className="taomni-input w-64"
            type="password"
            value={password}
            aria-label="Database password"
            placeholder={passwordRef ? "•••••• (saved in vault)" : ""}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordRef) clearPasswordRef();
            }}
          />
        <label
          className="flex items-center gap-1 text-[11px] cursor-pointer ml-2"
          title={vaultState === "empty" ? "Set up the vault on save to store passwords" : "Encrypt and store this password in the vault"}
        >
          <input
            type="checkbox"
            className="taomni-checkbox"
            data-testid="db-save-in-vault"
            checked={saveInVault}
            onChange={(e) => setSaveInVault(e.target.checked)}
          />
          Save in vault
        </label>
        <span className="taomni-pill">
          <Shield className="w-3 h-3" /> Encrypted
        </span>
      </Field>

      {isPresto && (
        <Field label="Catalog">
          <input
            className="taomni-input w-64"
            value={catalog}
            aria-label="Presto catalog"
            placeholder="hive / tpch / system"
            onChange={(e) => setCatalog(e.target.value)}
          />
        </Field>
      )}

      {!isRedis && (
        <Field label={isPresto ? "Schema" : "Database"}>
          <input
            className="taomni-input w-64"
            value={database}
            aria-label={isPresto ? "Presto schema" : "Database name"}
            placeholder={isPresto ? "(optional) default schema" : "database / schema name"}
            onChange={(e) => setDatabase(e.target.value)}
          />
        </Field>
      )}

      {isRedis && (
        <>
          <Field label="DB index">
            <input
              className="taomni-input w-20"
              type="number"
              min={0}
              max={15}
              value={redisDbIndex}
              aria-label="Redis DB index"
              onChange={(e) => setRedisDbIndex(e.target.value)}
            />
            <span className="ml-2 text-[var(--taomni-text-muted)]">0–15</span>
          </Field>
          <Field label="Key prefix">
            <input
              className="taomni-input w-64"
              value={database}
              aria-label="Redis key prefix"
              placeholder="(optional) default SCAN prefix"
              onChange={(e) => setDatabase(e.target.value)}
            />
          </Field>
        </>
      )}

      {isClickHouse && (
        <>
          <Field label="HTTP port">
            <input
              className="taomni-input w-24"
              value={httpPort}
              aria-label="ClickHouse HTTP port"
              placeholder="8123"
              onChange={(e) => setHttpPort(e.target.value)}
            />
          </Field>
          <Field label="Protocol">
            <Select
              value={chProtocol}
              className="w-40"
              options={["HTTP", "Native"]}
              onChange={setChProtocol}
            />
          </Field>
        </>
      )}

      <Field label="SSL / TLS">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={ssl} onChange={setSsl} />
          Use encrypted connection
        </label>
      </Field>

      <Field label="Timeout">
        <input
          className="taomni-input w-20"
          value={timeoutSecs}
          aria-label="Connection timeout seconds"
          onChange={(e) => setTimeoutSecs(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">seconds</span>
      </Field>
    </div>
  );
}

function HBaseSettings({
  host, setHost,
  port, setPort,
  username, setUsername,
  password, setPassword,
  passwordRef, clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  namespace, setNamespace,
  restPath, setRestPath,
  connectionMode, setConnectionMode,
  zkQuorum, setZkQuorum,
  zkRoot, setZkRoot,
  effectiveUser, setEffectiveUser,
  ssl, setSsl,
  timeoutSecs, setTimeoutSecs,
  authMethod, setAuthMethod,
  servicePrincipal, setServicePrincipal,
  principal, setPrincipal,
  keytabPath, setKeytabPath,
  krb5ConfPath, setKrb5ConfPath,
  hbaseSitePath, setHBaseSitePath,
}: {
  host: string; setHost: (v: string) => void;
  port: string; setPort: (v: string) => void;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string; clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  namespace: string; setNamespace: (v: string) => void;
  restPath: string; setRestPath: (v: string) => void;
  connectionMode: string; setConnectionMode: (v: string) => void;
  zkQuorum: string; setZkQuorum: (v: string) => void;
  zkRoot: string; setZkRoot: (v: string) => void;
  effectiveUser: string; setEffectiveUser: (v: string) => void;
  ssl: boolean; setSsl: (v: boolean) => void;
  timeoutSecs: string; setTimeoutSecs: (v: string) => void;
  authMethod: string; setAuthMethod: (v: string) => void;
  servicePrincipal: string; setServicePrincipal: (v: string) => void;
  principal: string; setPrincipal: (v: string) => void;
  keytabPath: string; setKeytabPath: (v: string) => void;
  krb5ConfPath: string; setKrb5ConfPath: (v: string) => void;
  hbaseSitePath: string; setHBaseSitePath: (v: string) => void;
}) {
  const isNative = connectionMode !== "rest";

  const handleBrowseSiteXml = async () => {
    try {
      const selected = await selectFilePath(hbaseSitePath || undefined);
      if (selected) setHBaseSitePath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleBrowseKeytab = async () => {
    try {
      const selected = await selectFilePath(keytabPath || undefined);
      if (selected) setKeytabPath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleBrowseKrb5Conf = async () => {
    try {
      const selected = await selectFilePath(krb5ConfPath || undefined);
      if (selected) setKrb5ConfPath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleAnalyzeSiteXml = async () => {
    if (!hbaseSitePath.trim()) return;
    try {
      const props = await hbaseParseSiteXml(hbaseSitePath.trim());
      if (props["hbase.zookeeper.quorum"]) {
        setZkQuorum(props["hbase.zookeeper.quorum"]);
      }
      if (props["zookeeper.znode.parent"]) {
        setZkRoot(props["zookeeper.znode.parent"]);
      }
      if (props["hbase.regionserver.kerberos.principal"] || props["hbase.master.kerberos.principal"]) {
        setServicePrincipal(props["hbase.regionserver.kerberos.principal"] || props["hbase.master.kerberos.principal"]);
      }
    } catch (err) {
      alert("Failed to parse hbase-site.xml: " + err);
    }
  };

  const handleAnalyzeKeytab = async () => {
    if (!keytabPath.trim()) return;
    try {
      const parsedPrincipal = await hbaseParseKeytabPrincipal(keytabPath.trim());
      if (parsedPrincipal) {
        setPrincipal(parsedPrincipal);
      }
    } catch (err) {
      alert("Failed to parse keytab: " + err);
    }
  };

  return (
    <div data-testid="hbase-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Mode">
        <select
          className="taomni-input w-64"
          data-testid="hbase-connection-mode"
          aria-label="HBase connection mode"
          value={isNative ? "native" : "rest"}
          onChange={(e) => setConnectionMode(e.target.value)}
        >
          <option value="native">Native RPC (ZooKeeper + RegionServer)</option>
          <option value="rest">REST / Stargate gateway</option>
        </select>
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {isNative ? "No gateway needed; talks the native protocol." : "Requires an HBase REST server."}
        </span>
      </Field>

      <Field label="Remote host">
        <input
          className="taomni-input w-64"
          value={host}
          aria-label="Remote host"
          placeholder="e.g. localhost or EMR header IP"
          onChange={(e) => setHost(e.target.value)}
        />
      </Field>
      <Field label="Port">
        <input
          className="taomni-input w-32"
          value={port}
          aria-label={isNative ? "HBase port" : "HBase REST port"}
          placeholder={isNative ? "2181" : "8080"}
          onChange={(e) => setPort(e.target.value)}
        />
      </Field>

      {isNative && (
        <>
          <Field label="HBase-site.xml path">
            <input
              className="taomni-input w-96 min-w-0"
              value={hbaseSitePath}
              aria-label="HBase site config file path"
              placeholder="(optional) /etc/hbase/conf/hbase-site.xml"
              onChange={(e) => setHBaseSitePath(e.target.value)}
            />
            <button
              type="button"
              className="taomni-btn px-2 shrink-0 py-1"
              title="Browse file"
              onClick={handleBrowseSiteXml}
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="taomni-btn px-2 shrink-0 py-1"
              title="Auto-analyze hbase-site.xml and populate fields"
              disabled={!hbaseSitePath.trim()}
              onClick={handleAnalyzeSiteXml}
            >
              Analyze
            </button>
          </Field>
          <Field label="ZK quorum">
            <input
              className="taomni-input w-64"
              value={zkQuorum}
              aria-label="HBase ZooKeeper quorum"
              placeholder="(optional) zk1:2181,zk2:2181 — defaults to host:port"
              onChange={(e) => setZkQuorum(e.target.value)}
            />
          </Field>
          <Field label="ZK root">
            <input
              className="taomni-input w-64"
              value={zkRoot}
              aria-label="HBase ZooKeeper root"
              placeholder="(optional) /hbase"
              onChange={(e) => setZkRoot(e.target.value)}
            />
          </Field>
          <Field label="Effective user">
            <input
              className="taomni-input w-64"
              value={effectiveUser}
              aria-label="HBase effective user"
              placeholder="(optional) defaults to root"
              onChange={(e) => setEffectiveUser(e.target.value)}
            />
          </Field>
          <Field label="Auth method">
            <select
              className="taomni-input w-64"
              data-testid="hbase-auth-method"
              aria-label="HBase auth method"
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value)}
            >
              <option value="simple">Simple (effective user only)</option>
              <option value="kerberos">Kerberos (GSSAPI)</option>
            </select>
          </Field>

          {authMethod === "kerberos" && (
            <>
              <Field label="Service principal">
                <input
                  className="taomni-input w-64"
                  data-testid="hbase-service-principal"
                  aria-label="HBase service principal"
                  value={servicePrincipal}
                  placeholder="hbase/_HOST@REALM"
                  onChange={(e) => setServicePrincipal(e.target.value)}
                />
              </Field>
              <Field label="Keytab path">
                <input
                  className="taomni-input w-96 min-w-0"
                  data-testid="hbase-keytab-path"
                  aria-label="HBase keytab file path"
                  value={keytabPath}
                  placeholder="(optional) /etc/security/keytabs/user.keytab"
                  onChange={(e) => setKeytabPath(e.target.value)}
                />
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Browse file"
                  onClick={handleBrowseKeytab}
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Auto-analyze keytab and extract principal"
                  disabled={!keytabPath.trim()}
                  onClick={handleAnalyzeKeytab}
                >
                  Parse
                </button>
                <span className="w-full text-[var(--taomni-text-muted)] mt-0.5 pl-1 block">
                  Auto-authenticates using keytab on connect.
                </span>
              </Field>
              <Field label="Krb5 config path">
                <input
                  className="taomni-input w-96 min-w-0"
                  data-testid="hbase-krb5-conf-path"
                  aria-label="HBase krb5 config file path"
                  value={krb5ConfPath}
                  placeholder="(optional) /etc/krb5.conf"
                  onChange={(e) => setKrb5ConfPath(e.target.value)}
                />
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Browse file"
                  onClick={handleBrowseKrb5Conf}
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
              </Field>
              {keytabPath.trim() && (
                <Field label="Principal">
                  <input
                    className="taomni-input w-64"
                    data-testid="hbase-principal"
                    aria-label="HBase client principal"
                    value={principal}
                    placeholder="user@EXAMPLE.COM"
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                </Field>
              )}
              {!keytabPath.trim() && (
                <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-1.5 pl-1">
                  <Info className="w-3 h-3 shrink-0" />
                  No keytab configured. Run <code className="taomni-mono">kinit</code> manually before connecting.
                </div>
              )}
            </>
          )}
        </>
      )}

      <Field label="Username">
        <input
          className="taomni-input w-64"
          value={username}
          aria-label="HBase username"
          placeholder="(optional) REST basic auth user"
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>

      <Field label="Password">
          <input
            className="taomni-input w-64"
            type="password"
            value={password}
            aria-label="HBase password"
            placeholder={passwordRef ? "•••••• (saved in vault)" : ""}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordRef) clearPasswordRef();
            }}
          />
        <label
          className="flex items-center gap-1 text-[11px] cursor-pointer ml-2"
          title={vaultState === "empty" ? "Set up the vault on save to store passwords" : "Encrypt and store this password in the vault"}
        >
          <input
            type="checkbox"
            className="taomni-checkbox"
            data-testid="hbase-save-in-vault"
            checked={saveInVault}
            onChange={(e) => setSaveInVault(e.target.checked)}
          />
          Save in vault
        </label>
        <span className="taomni-pill">
          <Shield className="w-3 h-3" /> Encrypted
        </span>
      </Field>

      <Field label="Namespace">
        <input
          className="taomni-input w-64"
          value={namespace}
          aria-label="HBase namespace"
          placeholder="(optional) default namespace"
          onChange={(e) => setNamespace(e.target.value)}
        />
      </Field>

      {!isNative && (
        <Field label="REST path">
          <input
            className="taomni-input w-64"
            value={restPath}
            aria-label="HBase REST path"
            placeholder="(optional) gateway prefix"
            onChange={(e) => setRestPath(e.target.value)}
          />
          <span className="ml-2 text-[var(--taomni-text-muted)]">Leave empty for Stargate root.</span>
        </Field>
      )}

      <Field label="SSL / TLS">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={ssl} onChange={setSsl} />
          Use HTTPS
        </label>
      </Field>

      <Field label="Timeout">
        <input
          className="taomni-input w-20"
          value={timeoutSecs}
          aria-label="HBase timeout seconds"
          onChange={(e) => setTimeoutSecs(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">seconds</span>
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
interface SessionEditorProps {
  session?: SessionConfig;
  defaultGroupPath?: string | null;
  /**
   * Pre-select the protocol when creating a *new* session (no `session`
   * prop). Accepts a session-type string (e.g. `"SFTP"`, `"SSH"`); falls
   * back to SSH if unrecognized. Ignored when editing an existing session.
   */
  initialProto?: string;
  onClose: () => void;
}

export function SessionEditor({ session, defaultGroupPath = null, initialProto, onClose }: SessionEditorProps) {
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
  const [username, setUsername] = useState(session?.username ?? "");
  const [specifyUser, setSpecifyUser] = useState(!!session?.username);
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
    if (t === "None") return "gssapi";
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
    () => !!passwordRef,
  );
  const vaultState = useVaultStore((s) => s.state);

  /* --- advanced SSH --- */
  const [x11, setX11] = useState(() => optionBoolean(initialOptions, "x11", true));
  const [x11Trusted, setX11Trusted] = useState(() => optionBoolean(initialOptions, "x11Trusted", true));
  const [compression, setCompression] = useState(() => optionBoolean(initialOptions, "compression", false));
  const [startupCmd, setStartupCmd] = useState(() => optionString(initialOptions, "startupCmd", ""));
  const [doNotExit, setDoNotExit] = useState(() => optionBoolean(initialOptions, "doNotExit", false));
  const [remoteEnv, setRemoteEnv] = useState(() => optionString(initialOptions, "remoteEnv", "Interactive shell"));
  const [sshBrowser, setSshBrowser] = useState(() => optionString(initialOptions, "sshBrowser", "SFTP protocol (recommended)"));
  const [usePrivKey, setUsePrivKey] = useState(
    extractAuthType(session?.auth_method) === "PrivateKey",
  );

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

  /* --- database session options (MySQL/PostgreSQL/ClickHouse/Presto/Redis) --- */
  const [dbCatalog, setDbCatalog] = useState(() => optionString(initialOptions, "dbCatalog", ""));
  const [dbDatabase, setDbDatabase] = useState(() => optionString(initialOptions, "dbDatabase", ""));
  const [dbSsl, setDbSsl] = useState(() => optionBoolean(initialOptions, "dbSsl", false));
  const [dbTimeout, setDbTimeout] = useState(() => optionString(initialOptions, "dbTimeout", "15"));
  const [dbHttpPort, setDbHttpPort] = useState(() => optionString(initialOptions, "dbHttpPort", "8123"));
  const [dbChProtocol, setDbChProtocol] = useState(() => optionString(initialOptions, "dbChProtocol", "HTTP"));
  const [dbRedisIndex, setDbRedisIndex] = useState(() => optionString(initialOptions, "dbRedisIndex", "0"));
  const [hbaseNamespace, setHBaseNamespace] = useState(() => optionString(initialOptions, "hbaseNamespace", ""));
  const [hbaseRestPath, setHBaseRestPath] = useState(() => optionString(initialOptions, "hbaseRestPath", ""));
  const [hbaseConnectionMode, setHBaseConnectionMode] = useState(() => optionString(initialOptions, "hbaseConnectionMode", "native"));
  const [hbaseZkQuorum, setHBaseZkQuorum] = useState(() => optionString(initialOptions, "hbaseZkQuorum", ""));
  const [hbaseZkRoot, setHBaseZkRoot] = useState(() => optionString(initialOptions, "hbaseZkRoot", ""));
  const [hbaseEffectiveUser, setHBaseEffectiveUser] = useState(() => optionString(initialOptions, "hbaseEffectiveUser", ""));
  const [hbaseAuthMethod, setHBaseAuthMethod] = useState(() => optionString(initialOptions, "hbaseAuthMethod", "simple"));
  const [hbaseServicePrincipal, setHBaseServicePrincipal] = useState(() => optionString(initialOptions, "hbaseServicePrincipal", ""));
  const [hbasePrincipal, setHBasePrincipal] = useState(() => optionString(initialOptions, "hbasePrincipal", ""));
  const [hbaseKeytabPath, setHBaseKeytabPath] = useState(() => optionString(initialOptions, "hbaseKeytabPath", ""));
  const [hbaseKrb5ConfPath, setHBaseKrb5ConfPath] = useState(() => optionString(initialOptions, "hbaseKrb5ConfPath", ""));
  const [hbaseSitePath, setHBaseSitePath] = useState(() => optionString(initialOptions, "hbaseSitePath", ""));

  /* --- proxy session options --- */
  const [proxyKind, setProxyKind] = useState<"http" | "socks5">(() => {
    const v = optionString(initialOptions, "proxyKind", "http");
    return v === "socks5" ? "socks5" : "http";
  });
  const [proxyTestUrl, setProxyTestUrl] = useState(() => optionString(initialOptions, "testUrl", "www.google.com:443"));

  /* --- terminal profile --- */
  const [terminalProfile, setTerminalProfile] = useState<TerminalProfile>(() =>
    getSessionTerminalProfile(session?.options_json) ?? loadGlobalTerminalProfile(),
  );

  /* --- WSL options --- */
  const [wslOptions, setWslOptions] = useState<WslOptions>(() =>
    parseWslOptions(session?.options_json),
  );
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">(
    () => (getAppPlatform() === "windows" ? "loading" : "unsupported"),
  );

  useEffect(() => {
    if (proto !== "WSL") return;
    if (getAppPlatform() !== "windows") {
      setWslStatus("unsupported");
      return;
    }
    let cancelled = false;
    setWslStatus("loading");
    listWslDistros()
      .then((distros) => {
        if (cancelled) return;
        setWslDistros(distros);
        setWslStatus("ready");
        // If editing a brand-new session, default to the system's default distro.
        if (!wslOptions.distro && distros.length > 0) {
          const def = distros.find((d) => d.isDefault) ?? distros[0];
          setWslOptions((prev) => ({ ...prev, distro: def.name }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setWslStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proto]);

  /* --- RDP options --- */
  const [rdpOptions, setRdpOptions] = useState<RdpOptions>(() =>
    parseRdpOptions(session?.options_json),
  );

  /* --- SFTP path mappings --- */
  const [pathMappings, setPathMappings] = useState<SftpPathMapping[]>(() =>
    parsePathMappingsFromOptions(session?.options_json),
  );

  /* --- object storage (S3 / Azure Blob) --- */
  const [oss, setOss] = useState<OssFormState>(() => ossFormFromOptions(session?.options_json));

  /* --- network settings --- */
  const [networkSettings, setNetworkSettings] = useState<NetworkSettingsValue>(
    () => getSessionNetworkSettings(session?.options_json),
  );

  /* --- test connection --- */
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /* --- derived --- */
  const needsHost = !["Serial", "File", "Shell", "WSL", "HBaseShell", "S3"].includes(proto);
  const isSSH = ["SSH", "SFTP"].includes(proto);
  const isRdp = proto === "RDP";
  const isDb = DB_PROTOS.includes(proto);
  const isHBase = proto === "HBaseShell";
  const isProxy = proto === "Proxy";
  const isObjectStorage = proto === "S3";
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

  const handleProtoChange = (p: Proto) => {
    setProto(p);
    setPort(String(DEFAULT_PORTS[p] ?? 22));
    // For File proto only the Bookmark sub-tab is meaningful; jump there so
    // the user lands on the relevant content.
    if (p === "File") setSection("bookmark");
    // Data-client protos open straight to the dedicated settings tab.
    if (DB_PROTOS.includes(p) || p === "HBaseShell") setSection("database");
    // Proxy proto opens to its settings tab.
    if (p === "Proxy") setSection("proxy");
    // Object storage opens straight to its settings tab.
    if (p === "S3") setSection("objectstorage");
  };

  /* Keep authMethod in sync with the radio group */
  const handleAuthRadio = (v: string) => {
    setAuthRadio(v);
    if (v === "password") {
      setAuthMethod("Password");
      setUsePrivKey(false);
    } else if (v === "privatekey") {
      setAuthMethod("PrivateKey");
      setUsePrivKey(true);
    } else if (v === "agent") {
      setAuthMethod("Agent");
      setUsePrivKey(false);
    } else {
      setAuthMethod("None");
      setUsePrivKey(false);
    }
  };

  const buildOptionsJson = ({
    passwordRefValue = passwordRef,
    networkSettingsValue = networkSettings,
    proxyPassValue = networkSettings.proxyPass,
    jumpPasswordValue = networkSettings.jumpPassword,
    ossConfigValue,
  }: {
    passwordRefValue?: string;
    networkSettingsValue?: NetworkSettingsValue;
    proxyPassValue?: string;
    jumpPasswordValue?: string;
    /** Resolved object-storage option map (secrets already swapped for vault
     *  refs by handleSave). Falls back to current form state when omitted. */
    ossConfigValue?: Record<string, unknown>;
  } = {}): string => {
    const previousOptions = stripDeprecatedCwdOptions(parseSessionOptions(session?.options_json));
    const wslOverrides: Record<string, unknown> =
      proto === "WSL"
        ? {
            ...serializeWslOptions(wslOptions),
            localShellPath: "wsl.exe",
            localShellArgs: buildWslLaunchArgs(wslOptions),
          }
        : {};
    const rdpOverrides: Record<string, unknown> =
      proto === "RDP"
        ? (JSON.parse(serializeRdpOptions(rdpOptions)) as Record<string, unknown>)
        : {};
    const dbOverrides: Record<string, unknown> = isDb
      ? {
          dbDatabase,
          dbCatalog,
          dbSsl,
          dbTimeout,
          dbHttpPort,
          dbChProtocol,
          dbRedisIndex,
        }
      : {};
    const proxyOverrides: Record<string, unknown> = isProxy
      ? { proxyKind, testUrl: proxyTestUrl }
      : {};
    const ossOverrides: Record<string, unknown> =
      proto === "S3"
        ? (ossConfigValue ?? {
            provider: oss.provider,
            endpoint: oss.endpoint,
            region: oss.region,
            pathStyle: oss.pathStyle,
            accessKeyId: oss.accessKeyId,
            secretAccessKey: oss.secretAccessKey,
            sessionToken: oss.sessionToken,
            defaultBucket: oss.defaultBucket,
            awsAuth: oss.awsAuth,
            awsProfile: oss.awsProfile,
            accountName: oss.accountName,
            accountKey: oss.accountKey,
            connectionString: oss.connectionString,
            sasToken: oss.sasToken,
            endpointSuffix: oss.endpointSuffix,
            defaultContainer: oss.defaultContainer,
            azureAuth: oss.azureAuth,
            azureBearerToken: oss.azureBearerToken,
            storageClass: oss.storageClass,
          })
        : {};
    const hbaseOverrides: Record<string, unknown> = isHBase
      ? {
          hbaseNamespace,
          hbaseRestPath,
          hbaseConnectionMode,
          hbaseZkQuorum,
          hbaseZkRoot,
          hbaseEffectiveUser,
          hbaseAuthMethod,
          hbaseServicePrincipal,
          hbasePrincipal,
          hbaseKeytabPath,
          hbaseKrb5ConfPath,
          hbaseSitePath,
          dbSsl,
          dbTimeout,
        }
      : {};

    return JSON.stringify({
      ...previousOptions,
      x11, x11Trusted, compression, startupCmd,
      description, tags, doNotExit, disableAiWrite,
      remoteEnv, sshBrowser, usePrivKey,
      fileEmbedInTab, fileExtraArgs,
      terminalProfile,
      // SSH password vault reference (vault:<id>). Empty string means no
      // saved password; the user types it on connect.
      passwordRef: passwordRefValue || "",
      // Strip the proxy password unless the user explicitly opted into
      // "Save in vault". `options_json` lands in the SQLite session row
      // in plaintext, so this is the gate keeping secrets out at rest.
      // When proxySaveAuth is on AND the value is already a vault: ref,
      // we keep it (the resolution happens server-side). The jump-host
      // password is gated the same way via jumpSaveAuth.
      networkSettings: {
        ...networkSettingsValue,
        proxyPass: networkSettingsValue.proxySaveAuth ? proxyPassValue : "",
        jumpPassword: networkSettingsValue.jumpSaveAuth ? jumpPasswordValue : "",
      },
      // SFTP deployment path mappings (only stored for SFTP sessions).
      ...(proto === "SFTP" ? { pathMappings } : {}),
      ...wslOverrides,
      ...rdpOverrides,
      ...dbOverrides,
      ...proxyOverrides,
      ...hbaseOverrides,
      ...ossOverrides,
    });
  };

  const buildConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => {
    const now = Math.floor(Date.now() / 1000);
    let auth: AuthMethod = "Password";
    if (authMethod === "PrivateKey")
      auth = { PrivateKey: { key_path: keyPath || "~/.ssh/id_ed25519" } };
    else if (authMethod === "Agent") auth = "Agent";
    else if (authMethod === "None") auth = "None";

    const displayName = name
      || (proto === "WSL"
        ? t("sessionEditor2.wslDefaultName", { distro: wslOptions.distro || "Linux" })
        : proto === "S3"
          ? (oss.defaultBucket || oss.defaultContainer || oss.accountName || oss.endpoint || "Object Storage")
          : (proto === "File" && host
            ? (host.split(/[\\/]/).filter(Boolean).pop() || host)
            : (host ? `${username ? username + "@" : ""}${host}` : "Local terminal")));
    return {
      id: session?.id ?? crypto.randomUUID(),
      name: displayName,
      session_type:
        proto === "S3"
          ? (engineForProvider(oss.provider) === "azure" ? "AzureBlob" : "S3")
          : protoToSessionType(proto),
      group_path: toStoredGroupPath(groupPath),
      host,
      port: parseInt(port) || DEFAULT_PORTS[proto] || 0,
      username: username || null,
      auth_method: auth,
      options_json: buildOptionsJson(),
      created_at: session?.created_at ?? now,
      updated_at: now,
      last_connected_at: session?.last_connected_at ?? null,
      sort_order: session?.sort_order ?? 0,
      ...overrides,
    };
  };

  const validate = () => {
    if (needsHost && !host.trim()) return t("sessionEditor2.errHostRequired");
    if (proto === "File" && !host.trim()) return t("sessionEditor2.errFilePathRequired");
    if (proto === "WSL" && !wslOptions.distro.trim()) return t("sessionEditor2.errWslDistroRequired");
    if (proto === "Presto" && !dbCatalog.trim()) return "Presto catalog is required.";
    if (isSSH && specifyUser && !username.trim()) return t("sessionEditor2.errUsernameEmpty");
    if (authMethod === "PrivateKey" && !keyPath.trim()) return t("sessionEditor2.errKeyPathRequired");
    if (proto === "HBaseShell") {
      if (hbaseConnectionMode === "rest" && !host.trim()) {
        return "HBase REST host is required.";
      }
      if (hbaseConnectionMode === "native" && !hbaseSitePath.trim() && !hbaseZkQuorum.trim() && !host.trim()) {
        return "HBase ZooKeeper quorum, HBase-site.xml, or Remote host is required.";
      }
    }
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError(null);

    // If the user wants to remember the SSH/database password and typed a
    // fresh plaintext into the password field, push it into the vault first
    // and capture the resulting `vault:<id>` reference. We do this *before*
    // building the config so the reference lands in options_json.
    let nextPasswordRef = passwordRef;
    if (
      (isSSH || isDb || isHBase || proto === "RDP" || proto === "VNC" || isProxy) &&
      (isDb || isHBase || proto === "RDP" || proto === "VNC" || isProxy || authMethod === "Password") &&
      saveInVault &&
      password.length > 0
    ) {
      // The vault must be unlocked to encrypt the password. If it is empty or
      // locked, pop the on-demand gate (set master password / unlock) instead
      // of failing with a text hint. Bail out of the save if the user cancels.
      const ready = await ensureVaultReady(t("vault.gateReasonSession"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedSave"));
        return;
      }
      try {
        const kind =
          proto === "RDP"
            ? "rdp-password"
            : proto === "VNC"
              ? "vnc-password"
              : isProxy
                ? "proxy-password"
                : isHBase
                  ? "hbase-password"
                  : isDb
                    ? "db-password"
                    : "ssh-password";
        const label = `${username || "user"}@${host || "?"}:${port}`;
        const result = await vaultPut(kind, label, password);
        nextPasswordRef = result.reference;
        setPasswordRef(result.reference);
        setPassword("");
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    } else if (!saveInVault) {
      // User unchecked Save in vault: forget any previous reference.
      nextPasswordRef = "";
    }

    // Same dance for the proxy password when proxySaveAuth is enabled and
    // the user typed a fresh plaintext (i.e. the value isn't already a
    // vault: reference).
    let nextProxyPass = networkSettings.proxyPass;
    if (
      networkSettings.proxySaveAuth &&
      networkSettings.proxyPass.length > 0 &&
      !isVaultReference(networkSettings.proxyPass)
    ) {
      const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `proxy://${networkSettings.proxyHost}:${networkSettings.proxyPort}`;
        const result = await vaultPut("proxy-password", label, networkSettings.proxyPass);
        nextProxyPass = result.reference;
        setNetworkSettings({ ...networkSettings, proxyPass: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // And once more for the SSH jump-host password (manual mode only — when a
    // jump session is selected, its own saved credential is resolved
    // server-side and there is no separate jump password to persist).
    let nextJumpPass = networkSettings.jumpPassword;
    if (
      networkSettings.jumpSaveAuth &&
      networkSettings.jumpSessionId.trim() === "" &&
      networkSettings.jumpPassword.length > 0 &&
      !isVaultReference(networkSettings.jumpPassword)
    ) {
      const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `jump://${networkSettings.jumpUser}@${networkSettings.jumpHost}:${networkSettings.jumpPort}`;
        const result = await vaultPut("jump-password", label, networkSettings.jumpPassword);
        nextJumpPass = result.reference;
        setNetworkSettings({ ...networkSettings, jumpPassword: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    setPasswordRef(nextPasswordRef);

    // Object-storage secrets: swap freshly-typed plaintext for vault refs when
    // "Save secrets in vault" is on. When off, secrets are stored as plaintext
    // in options_json (the backend resolve() accepts either form).
    let ossConfigValue: Record<string, unknown> | undefined;
    if (proto === "S3") {
      const isAzure = engineForProvider(oss.provider) === "azure";
      const label = oss.defaultBucket || oss.defaultContainer || oss.accountName || oss.endpoint || oss.provider;
      const secretFields: Array<{ key: keyof OssFormState; kind: string }> = isAzure
        ? [
            { key: "accountKey", kind: "azure-account-key" },
            { key: "sasToken", kind: "azure-sas" },
            { key: "connectionString", kind: "azure-connstr" },
            { key: "azureBearerToken", kind: "azure-bearer" },
          ]
        : [
            { key: "secretAccessKey", kind: "s3-secret-key" },
            { key: "sessionToken", kind: "s3-session-token" },
          ];
      const resolved: Record<string, string> = {};
      for (const { key, kind } of secretFields) {
        const value = oss[key] as string;
        if (!value || isVaultReference(value) || !saveInVault) {
          resolved[key] = value;
          continue;
        }
        const ready = await ensureVaultReady(t("vault.gateReasonSession"));
        if (!ready) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const r = await vaultPut(kind, `${kind} ${label}`, value);
          resolved[key] = r.reference;
        } catch (err) {
          if (isVaultLockedError(err)) setSaveError(t("sessionEditor2.errVaultLockedSave"));
          else setSaveError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      const next: OssFormState = { ...oss, ...(resolved as Partial<OssFormState>) };
      setOss(next);
      ossConfigValue = {
        provider: next.provider,
        endpoint: next.endpoint,
        region: next.region,
        pathStyle: next.pathStyle,
        accessKeyId: next.accessKeyId,
        secretAccessKey: next.secretAccessKey,
        sessionToken: next.sessionToken,
        defaultBucket: next.defaultBucket,
        awsAuth: next.awsAuth,
        awsProfile: next.awsProfile,
        accountName: next.accountName,
        accountKey: next.accountKey,
        connectionString: next.connectionString,
        sasToken: next.sasToken,
        endpointSuffix: next.endpointSuffix,
        defaultContainer: next.defaultContainer,
        azureAuth: next.azureAuth,
        azureBearerToken: next.azureBearerToken,
        storageClass: next.storageClass,
      };
    }

    const config = buildConfig({
      options_json: buildOptionsJson({
        passwordRefValue: nextPasswordRef,
        proxyPassValue: nextProxyPass,
        jumpPasswordValue: nextJumpPass,
        ossConfigValue,
      }),
    });

    if (isEdit) {
      await updateSession(config);
    } else {
      await addSession(config);
    }
    onClose();
  };

  const handleSaveTemplate = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    const config = buildConfig({
      id: crypto.randomUUID(),
      name: t("sessionEditor2.templateName", { base: name || host || proto }),
      group_path: "Templates",
      last_connected_at: null,
    });
    await addSession(config);
    setTestResult({ ok: true, msg: t("sessionEditor2.templateSaved") });
  };

  const handleReset = () => {
    const nextOptions = parseSessionOptions(session?.options_json);
    const nextProto = sessionTypeToProto(session?.session_type, session?.options_json);
    setProto(nextProto);
    setSection("advanced");
    setName(session?.name ?? "");
    setHost(session?.host ?? "");
    setPort(String(session?.port ?? DEFAULT_PORTS[nextProto] ?? 22));
    setUsername(session?.username ?? "");
    setSpecifyUser(!!session?.username);
    setGroupPath(toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "");
    const nextAuth = extractAuthType(session?.auth_method);
    setAuthMethod(nextAuth);
    setAuthRadio(nextAuth === "PrivateKey" ? "privatekey" : nextAuth === "Agent" ? "agent" : nextAuth === "None" ? "gssapi" : "password");
    setKeyPath(extractKeyPath(session?.auth_method));
    setPassword("");
    const restoredRef = optionString(nextOptions, "passwordRef", "");
    setPasswordRef(restoredRef);
    setSaveInVault(!!restoredRef);
    setX11(optionBoolean(nextOptions, "x11", true));
    setX11Trusted(optionBoolean(nextOptions, "x11Trusted", true));
    setCompression(optionBoolean(nextOptions, "compression", false));
    setStartupCmd(optionString(nextOptions, "startupCmd", ""));
    setDoNotExit(optionBoolean(nextOptions, "doNotExit", false));
    setDisableAiWrite(optionBoolean(nextOptions, "disableAiWrite", false));
    setRemoteEnv(optionString(nextOptions, "remoteEnv", "Interactive shell"));
    setSshBrowser(optionString(nextOptions, "sshBrowser", "SFTP protocol (recommended)"));
    setUsePrivKey(nextAuth === "PrivateKey");
    setDescription(optionString(nextOptions, "description", ""));
    setTags(optionString(nextOptions, "tags", ""));
    setFileEmbedInTab(optionBoolean(nextOptions, "fileEmbedInTab", true));
    setFileExtraArgs(optionString(nextOptions, "fileExtraArgs", ""));
    setDbCatalog(optionString(nextOptions, "dbCatalog", ""));
    setDbDatabase(optionString(nextOptions, "dbDatabase", ""));
    setDbSsl(optionBoolean(nextOptions, "dbSsl", false));
    setDbTimeout(optionString(nextOptions, "dbTimeout", "15"));
    setDbHttpPort(optionString(nextOptions, "dbHttpPort", "8123"));
    setDbChProtocol(optionString(nextOptions, "dbChProtocol", "HTTP"));
    setDbRedisIndex(optionString(nextOptions, "dbRedisIndex", "0"));
    setHBaseNamespace(optionString(nextOptions, "hbaseNamespace", ""));
    setHBaseRestPath(optionString(nextOptions, "hbaseRestPath", ""));
    setHBaseConnectionMode(optionString(nextOptions, "hbaseConnectionMode", "native"));
    setHBaseZkQuorum(optionString(nextOptions, "hbaseZkQuorum", ""));
    setHBaseZkRoot(optionString(nextOptions, "hbaseZkRoot", ""));
    setHBaseEffectiveUser(optionString(nextOptions, "hbaseEffectiveUser", ""));
    setHBaseAuthMethod(optionString(nextOptions, "hbaseAuthMethod", "simple"));
    setHBaseServicePrincipal(optionString(nextOptions, "hbaseServicePrincipal", ""));
    setHBasePrincipal(optionString(nextOptions, "hbasePrincipal", ""));
    setHBaseKeytabPath(optionString(nextOptions, "hbaseKeytabPath", ""));
    setHBaseKrb5ConfPath(optionString(nextOptions, "hbaseKrb5ConfPath", ""));
    setHBaseSitePath(optionString(nextOptions, "hbaseSitePath", ""));
    setTerminalProfile(getSessionTerminalProfile(session?.options_json) ?? loadGlobalTerminalProfile());
    setNetworkSettings(getSessionNetworkSettings(session?.options_json));
    setWslOptions(parseWslOptions(session?.options_json));
    setRdpOptions(parseRdpOptions(session?.options_json));
    setPathMappings(parsePathMappingsFromOptions(session?.options_json));
    setOss(ossFormFromOptions(session?.options_json));
    setSaveError(null);
    setTestResult(null);
  };

  const handleHostLookup = () => {
    let parsed: ReturnType<typeof parseUserHostPort> = null;
    try {
      parsed = parseUserHostPort(host);
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    setHost(parsed.host);
    if (parsed.username) {
      setUsername(parsed.username);
      setSpecifyUser(true);
    }
    if (parsed.port) setPort(String(parsed.port));
  };

  const handleBrowseKey = async () => {
    setSaveError(null);
    try {
      const selected = await selectPrivateKeyFile(keyPath || "~/.ssh/id_ed25519");
      if (!selected) return;
      setKeyPath(selected.trim());
      setUsePrivKey(true);
      handleAuthRadio("privatekey");
    } catch (err) {
      setSaveError(t("sessionEditor2.errKeyChooser", { error: String(err) }));
    }
  };

  const handleBrowseFileTarget = async () => {
    setSaveError(null);
    try {
      const selected = await selectFilePath(host || undefined);
      if (selected) setHost(selected.trim());
    } catch (err) {
      setSaveError(t("sessionEditor2.errFileChooser", { error: String(err) }));
    }
  };

  const handleBrowseFolderTarget = async () => {
    setSaveError(null);
    try {
      const selected = await selectFolderPath(host || undefined);
      if (selected) setHost(selected.trim());
    } catch (err) {
      setSaveError(t("sessionEditor2.errFolderChooser", { error: String(err) }));
    }
  };

  const handleNewFolder = async () => {
    const next = await promptAppDialog({
      title: t("sessionEditor2.promptNewFolder"),
      initialValue: groupPath || t("sessionEditor2.promptNewFolderDefault"),
      allowEmpty: true,
    });
    const normalized = normalizeGroupPath(next);
    if (!normalized) return;
    setGroupPath(toStoredGroupPath(normalized) ?? "");
    void createFolderPath(normalized);
  };

  const handleDelete = async () => {
    if (session) {
      await removeSession(session.id);
      onClose();
    }
  };

  const handleTestConnection = async () => {
    if (!host || !username) {
      setTestResult({ ok: false, msg: t("sessionEditor2.testHostUserRequired") });
      return;
    }
    if (authMethod === "Password" && !password) {
      setTestResult({ ok: false, msg: t("sessionEditor2.testEnterPassword") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      let authData: string | null = null;
      if (authMethod === "Password") authData = password;
      else if (authMethod === "PrivateKey")
        authData = keyPath || "~/.ssh/id_ed25519";
      const msg = await testSshConnection(
        host,
        parseInt(port) || 22,
        username,
        authMethod,
        authData,
        JSON.stringify(toNetworkSettingsPayload(networkSettings)),
      );
      setTestResult({ ok: true, msg });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  /** Build a one-shot `DbConnectInfo` from the current editor state. The
   *  password prefers the freshly-typed plaintext, falling back to a saved
   *  vault reference (resolved server-side). */
  const buildDbConnectInfo = (): DbConnectInfo => ({
    sessionId: session?.id ?? "db-editor-test",
    engine: proto as DbConnectInfo["engine"],
    host,
    port: parseInt(port) || DEFAULT_PORTS[proto] || 0,
    username: username || null,
    password: password || passwordRef || undefined,
    catalog: proto === "Presto" ? dbCatalog || null : null,
    database: dbDatabase || null,
    ssl: dbSsl,
    timeoutSecs: parseInt(dbTimeout) || null,
    httpPort: proto === "ClickHouse" ? parseInt(dbHttpPort) || 8123 : null,
    protocol: proto === "ClickHouse" ? dbChProtocol.toLowerCase() : null,
    dbIndex: proto === "Redis" ? parseInt(dbRedisIndex) || 0 : null,
    // Route the test probe through the same proxy / SSH jump host the saved
    // connection uses. Only attach when a proxy/jump is actually selected so a
    // direct connection skips the backend loopback forwarder entirely (mirrors
    // sessionToDbConnectInfo in MainLayout).
    networkSettings:
      networkSettings.proxyKind !== "none"
        ? toNetworkSettingsPayload(networkSettings)
        : null,
  });

  const buildHBaseConnectInfo = (): HBaseConnectInfo => ({
    sessionId: session?.id ?? "hbase-editor-test",
    host,
    port: parseInt(port) || DEFAULT_PORTS.HBaseShell,
    username: username || null,
    password: password || passwordRef || undefined,
    ssl: dbSsl,
    timeoutSecs: parseInt(dbTimeout) || null,
    restPath: hbaseRestPath || null,
    namespace: hbaseNamespace || null,
    connectionMode: hbaseConnectionMode === "rest" ? "rest" : "native",
    zkQuorum: hbaseZkQuorum || null,
    zkRoot: hbaseZkRoot || null,
    effectiveUser: hbaseEffectiveUser || null,
    authMethod: hbaseAuthMethod === "kerberos" ? "kerberos" : "simple",
    servicePrincipal: hbaseServicePrincipal || null,
    principal: hbasePrincipal || null,
    keytabPath: hbaseKeytabPath || null,
    krb5ConfPath: hbaseKrb5ConfPath || null,
    hbaseSitePath: hbaseSitePath || null,
  });

  const handleTestDbConnection = async () => {
    if (!host) {
      setTestResult({ ok: false, msg: t("sessionEditor2.errHostRequired") });
      return;
    }
    if (proto === "Presto" && !dbCatalog.trim()) {
      setTestResult({ ok: false, msg: "Presto catalog is required." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await dbTestConnection(buildDbConnectInfo());
      setTestResult({ ok: true, msg });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleTestHBaseConnection = async () => {
    if (!host) {
      setTestResult({ ok: false, msg: t("sessionEditor2.errHostRequired") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await hbaseTestConnection(buildHBaseConnectInfo());
      setTestResult({ ok: true, msg });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleTestProxyConnection = async () => {
    if (!host) {
      setTestResult({ ok: false, msg: t("sessionEditor2.proxyHostRequired") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const [testHost, testPortStr] = (proxyTestUrl || "www.google.com:443").split(":");
      const testPort = parseInt(testPortStr) || 443;
      const msg = await testProxyConnection(
        proxyKind,
        host,
        parseInt(port) || 3128,
        username || "",
        password || passwordRef || "",
        testHost,
        testPort,
      );
      setTestResult({ ok: true, msg });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveAsProxySession = async () => {
    const ns = networkSettings;
    if (!ns.proxyHost.trim()) {
      setTestResult({ ok: false, msg: t("sessionEditor2.proxyHostRequired") });
      return;
    }
    const proxyPort = parseInt(ns.proxyPort) || 3128;
    const now = Math.floor(Date.now() / 1000);
    const proxyName = `${ns.proxyKind === "http" ? "HTTP" : "SOCKS5"} ${ns.proxyHost}:${proxyPort}`;

    // Carry the proxy password into the new Proxy session as a vault reference,
    // mirroring how SSH passwords live in options_json.passwordRef. An existing
    // vault: ref is reused as-is; fresh plaintext is encrypted first (which may
    // require unlocking / creating the vault). Bail out if the gate is cancelled
    // so we never drop the secret on the floor or store it in plaintext at rest.
    let proxyPasswordRef = "";
    if (ns.proxyPass.length > 0) {
      if (isVaultReference(ns.proxyPass)) {
        proxyPasswordRef = ns.proxyPass;
      } else {
        const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
        if (!ready) {
          setTestResult({ ok: false, msg: t("sessionEditor2.errVaultLockedProxy") });
          return;
        }
        try {
          const label = `proxy://${ns.proxyHost}:${proxyPort}`;
          const result = await vaultPut("proxy-password", label, ns.proxyPass);
          proxyPasswordRef = result.reference;
        } catch (err) {
          setTestResult({
            ok: false,
            msg: isVaultLockedError(err)
              ? t("sessionEditor2.errVaultLockedProxy")
              : err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    }

    const config: SessionConfig = {
      id: crypto.randomUUID(),
      name: proxyName,
      session_type: "Proxy",
      group_path: null,
      host: ns.proxyHost.trim(),
      port: proxyPort,
      username: ns.proxyUser || null,
      auth_method: ns.proxyUser ? "Password" : "None",
      options_json: JSON.stringify({
        proxyKind: ns.proxyKind === "http" ? "http" : "socks5",
        testUrl: "www.google.com:443",
        ...(proxyPasswordRef ? { passwordRef: proxyPasswordRef } : {}),
      }),
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    };
    try {
      await addSession(config);
      setTestResult({ ok: true, msg: t("sessionEditor2.proxySessionSaved") });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    }
  };

  const sectionTabs: { id: SectionTab; label: string; icon: React.ReactNode }[] = proto === "File"
    ? [
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isProxy
    ? [
        { id: "proxy", label: t("sessionEditor2.proxyKindLabel"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isDb || isHBase
    ? [
        { id: "database", label: isHBase ? "HBase settings" : t("sessionEditor2.sectionDatabase"), icon: <Database className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        // DB engines can tunnel through a proxy / SSH jump host; HBase does not
        // (yet) route through the loopback forwarder, so no Network tab for it.
        ...(isDb
          ? [{ id: "network" as SectionTab, label: t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isObjectStorage
    ? [
        { id: "objectstorage", label: "Object storage", icon: <Cloud className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        // Object storage (HTTPS) can route through an HTTP/SOCKS5 proxy or an
        // SSH jump host, just like the DB engines.
        { id: "network", label: t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : [
        ...(isSSH
          ? [{ id: "advanced" as SectionTab, label: t("sessionEditor2.sectionAdvancedSsh"), icon: <Shield className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        // SFTP gets a dedicated path mappings tab
        ...(proto === "SFTP"
          ? [{ id: "mappings" as SectionTab, label: t("pathMappings.sectionTitle"), icon: <Folder className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        // RDP gets a dedicated options tab in place of the Terminal tab
        // (terminal appearance is meaningless for a graphical RDP session).
        ...(isRdp
          ? [{ id: "rdp" as SectionTab, label: t("rdp.options.title"), icon: <Monitor className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : [{ id: "terminal" as SectionTab, label: t("sessionEditor2.sectionTerminal"), icon: <TerminalIcon className="w-3 h-3 inline -mt-0.5 mr-1" /> }]),
        { id: "network",  label: t("sessionEditor2.sectionNetwork"),  icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"),  icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ];

  /* If we switched away from SSH and were on the advanced tab, fall back.
   * Likewise default RDP to its own options tab and bounce non-RDP protos
   * off the rdp tab, and DB protos onto the database tab. */
  const activeSection =
    proto === "File"
      ? "bookmark"
      : isProxy
        ? (section === "proxy" || section === "bookmark" ? section : "proxy")
        : isObjectStorage
        ? (section === "objectstorage" || section === "bookmark" || section === "network" ? section : "objectstorage")
        : isDb || isHBase
        ? (section === "database" || section === "bookmark" || (isDb && section === "network") ? section : "database")
        : section === "advanced" && !isSSH
          ? (isRdp ? "rdp" : "terminal")
          : section === "rdp" && !isRdp
            ? "terminal"
            : section === "mappings" && proto !== "SFTP"
              ? "terminal"
              : section === "terminal" && isRdp
              ? "rdp"
              : section === "database"
                ? "terminal"
                : section;

  const { containerRef, handleRef } = useModalDraggableAndResizable({ minWidth: 600, minHeight: 400 });

  const handleShortcutTest = () => {
    if (testing) return;
    if (isSSH && needsHost) {
      handleTestConnection();
    } else if (isDb) {
      void handleTestDbConnection();
    } else if (isHBase) {
      void handleTestHBaseConnection();
    } else if (isProxy) {
      void handleTestProxyConnection();
    }
  };

  useModalShortcuts({
    onCancel: onClose,
    onSave: () => {
      void handleSave();
    },
    onTest: handleShortcutTest,
  });

  const shortcuts = getShortcutSuffixes();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        ref={containerRef}
        data-testid="session-editor"
        className="w-[1020px] max-w-[96%] max-h-[92vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        {/* Modal title bar */}
        <div
          ref={handleRef}
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{
            background: "linear-gradient(to bottom,#5895c8,#2b5d8b)",
            color: "white",
          }}
        >
          <Bookmark className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">
            {isEdit ? t("sessionEditor2.titleEdit") : t("sessionEditor2.titleNew")}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] opacity-95">
            <button
              title={t("sessionEditor2.helpTitle")}
              className="hover:bg-white/15 rounded p-0.5"
              onClick={() => setTestResult({ ok: true, msg: t("sessionEditor2.helpMessage") })}
              type="button"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
            <button
              title={t("sessionEditor2.closeTitle")}
              className="hover:bg-red-500 rounded p-0.5"
              onClick={onClose}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Protocol picker */}
        <div
          className="px-3 pt-3 pb-2 border-b shrink-0"
          style={{ borderColor: "var(--taomni-divider)" }}
        >
          <div className="flex flex-wrap gap-1">
            {PROTOS.map((p) => (
              <button
                key={p.id}
                data-testid={`session-proto-${p.id.toLowerCase()}`}
                className="taomni-proto-btn"
                data-active={proto === p.id}
                onClick={() => handleProtoChange(p.id)}
                type="button"
              >
                <span
                  style={{
                    color: proto === p.id ? "var(--taomni-accent)" : p.color,
                  }}
                >
                  {p.icon}
                </span>
                <span>{p.id}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Basic settings (blue header) */}
        {needsHost && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {t("sessionEditor2.basicTitle", { proto })}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                {t("sessionEditor2.remoteHost")}
              </label>
              <div className="col-span-5 flex items-center gap-1">
                <input
                  data-testid="session-host"
                  className="taomni-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={handleHostLookup}
                  aria-label={t("sessionEditor2.remoteHostAria")}
                  placeholder={t("sessionEditor2.remoteHostPlaceholder")}
                />
                <button
                  title={t("sessionEditor2.lookup")}
                  className="taomni-btn px-2"
                  onClick={handleHostLookup}
                  type="button"
                >
                  <Search className="w-3 h-3 inline -mt-0.5" />
                </button>
              </div>
              <label className="col-span-3 text-[12px] flex items-center gap-1.5 justify-end">
                <Checkbox checked={specifyUser} onChange={setSpecifyUser} />
                <span>{t("sessionEditor2.specifyUsername")}</span>
              </label>
              <input
                data-testid="session-user"
                className="taomni-input col-span-2"
                value={username}
                disabled={!specifyUser}
                onChange={(e) => setUsername(e.target.value)}
                aria-label={t("sessionEditor2.usernameAria")}
                placeholder={t("sessionEditor2.usernamePlaceholder")}
              />

              <label className="col-span-2 text-[12px] text-right">{t("sessionEditor2.portLabel")}</label>
              <input
                data-testid="session-port"
                className="taomni-input col-span-2"
                value={port}
                aria-label={t("sessionEditor2.portAria")}
                onChange={(e) => setPort(e.target.value)}
              />
              <div className="col-span-8 text-[11px] text-[var(--taomni-text-muted)]">
                {(() => {
                  const tip = t("sessionEditor2.autofillTip", { snippet: "%SNIPPET%" });
                  const [before, after] = tip.split("%SNIPPET%");
                  return (
                    <>
                      {before}
                      <span
                        className="taomni-mono px-1 border rounded"
                        style={{ background: "var(--taomni-input-bg)", borderColor: "var(--taomni-divider)" }}
                      >
                        user@host:port
                      </span>
                      {after}
                    </>
                  );
                })()}
              </div>

              {(proto === "RDP" || proto === "VNC" || isProxy) && (
                <>
                  <label className="col-span-2 text-[12px] text-right">
                    {t("sessionEditor2.passwordLabel")}
                  </label>
                  <div className="col-span-10 flex items-center gap-2">
                      <input
                        data-testid="session-password"
                        className="taomni-input w-64"
                        type="password"
                        value={password}
                        aria-label={t("sessionEditor2.passwordLabel")}
                        placeholder={passwordRef ? t("sessionEditor2.passwordPlaceholderSaved") : ""}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (passwordRef) setPasswordRef("");
                        }}
                      />
                    <label
                      className="flex items-center gap-1 text-[11px] cursor-pointer"
                      title={
                        vaultState === "empty"
                          ? t("sessionEditor2.saveInVaultTitleSetup")
                          : t("sessionEditor2.saveInVaultTitleDefault")
                      }
                    >
                      <input
                        type="checkbox"
                        className="taomni-checkbox"
                        data-testid="session-save-in-vault"
                        checked={saveInVault}
                        onChange={(e) => setSaveInVault(e.target.checked)}
                      />
                      {t("sessionEditor2.saveInVault")}
                    </label>
                    <span className="taomni-pill">
                      <Shield className="w-3 h-3" /> {t("sessionEditor2.encryptedPill")}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Basic File settings — appears for the File protocol only */}
        {proto === "File" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <FileText className="w-3.5 h-3.5" />
              {t("sessionEditor2.basicFileTitle")}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                {t("sessionEditor2.fileTargetLabel")}
              </label>
              <div className="col-span-10 flex items-center gap-1">
                <input
                  data-testid="session-file-target"
                  className="taomni-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  aria-label={t("sessionEditor2.fileTargetAria")}
                  placeholder={t("sessionEditor2.fileTargetPlaceholder")}
                />
                <button
                  title={t("sessionEditor2.browseFolder")}
                  className="taomni-btn px-2"
                  onClick={() => void handleBrowseFolderTarget()}
                  type="button"
                >
                  <Folder className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
                <button
                  title={t("sessionEditor2.browseFile")}
                  className="taomni-btn px-2"
                  onClick={() => void handleBrowseFileTarget()}
                  type="button"
                >
                  <FileText className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
              </div>
              <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)]">
                {t("sessionEditor2.fileTargetHint")}
              </div>
            </div>
          </div>
        )}

        {/* Basic WSL settings — appears for the WSL protocol only */}
        {proto === "WSL" && (
          <div
            data-testid="session-wsl-section"
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {t("wsl.options.title")}
            </div>
            <WslOptionsForm
              options={wslOptions}
              distros={wslDistros}
              status={wslStatus}
              onChange={setWslOptions}
            />
          </div>
        )}

        {/* Section tabs */}
        <div className="px-3 pt-2 flex shrink-0" style={{ background: "transparent" }}>
          {sectionTabs.map((t) => (
            <button
              key={t.id}
              data-testid={`session-section-${t.id}`}
              className="taomni-section-tab"
              data-active={activeSection === t.id}
              onClick={() => setSection(t.id)}
              type="button"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <div className="flex-1 border-b" style={{ borderColor: "var(--taomni-input-border)" }} />
        </div>

        {/* Section body */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x border-b"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}
        >
          {activeSection === "mappings" && proto === "SFTP" && (
            <div data-testid="session-sftp-mappings-section" className="flex flex-col gap-3">
              <div className="text-[12px] text-[var(--taomni-text-muted)]">
                {t("pathMappings.sectionDescription")}
              </div>
              <PathMappingsEditor
                mappings={pathMappings}
                onChange={setPathMappings}
                canBrowseLocal
                onBrowseLocal={async (_index, current) => {
                  const { selectFolderPath } = await import("../../lib/ipc");
                  try {
                    const result = await selectFolderPath(current || undefined);
                    return result ?? null;
                  } catch {
                    return null;
                  }
                }}
              />
            </div>
          )}

          {activeSection === "advanced" && isSSH && (
            <AdvancedSshSettings
              t={t}
              x11={x11} setX11={setX11}
              x11Trusted={x11Trusted} setX11Trusted={setX11Trusted}
              compression={compression} setCompression={setCompression}
              startupCmd={startupCmd} setStartupCmd={setStartupCmd}
              doNotExit={doNotExit} setDoNotExit={setDoNotExit}
              remoteEnv={remoteEnv} setRemoteEnv={setRemoteEnv}
              sshBrowser={sshBrowser} setSshBrowser={setSshBrowser}
              authRadio={authRadio} setAuthRadio={handleAuthRadio}
              password={password} setPassword={setPassword}
              passwordRef={passwordRef}
              clearPasswordRef={() => setPasswordRef("")}
              saveInVault={saveInVault} setSaveInVault={setSaveInVault}
              vaultState={vaultState}
              usePrivKey={usePrivKey} setUsePrivKey={(value) => {
                if (value) {
                  handleAuthRadio("privatekey");
                } else {
                  handleAuthRadio("password");
                }
              }}
              keyPath={keyPath} setKeyPath={setKeyPath}
              onBrowseKey={handleBrowseKey}
            />
          )}

          {activeSection === "terminal" && (
            <TerminalSettings profile={terminalProfile} onProfileChange={setTerminalProfile} />
          )}
          {activeSection === "rdp" && (
            <div data-testid="session-rdp-section">
              <RdpOptionsForm options={rdpOptions} onChange={setRdpOptions} />
            </div>
          )}
          {activeSection === "database" && isDb && (
            <div data-testid="session-database-section">
              <DatabaseSettings
                proto={proto}
                username={username} setUsername={(v) => { setUsername(v); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                vaultState={vaultState}
                catalog={dbCatalog} setCatalog={setDbCatalog}
                database={dbDatabase} setDatabase={setDbDatabase}
                ssl={dbSsl} setSsl={setDbSsl}
                timeoutSecs={dbTimeout} setTimeoutSecs={setDbTimeout}
                httpPort={dbHttpPort} setHttpPort={setDbHttpPort}
                chProtocol={dbChProtocol} setChProtocol={setDbChProtocol}
                redisDbIndex={dbRedisIndex} setRedisDbIndex={setDbRedisIndex}
              />
            </div>
          )}
          {activeSection === "database" && isHBase && (
            <div data-testid="session-hbase-section">
              <HBaseSettings
                host={host} setHost={setHost}
                port={port} setPort={setPort}
                username={username} setUsername={(v) => { setUsername(v); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                vaultState={vaultState}
                namespace={hbaseNamespace} setNamespace={setHBaseNamespace}
                restPath={hbaseRestPath} setRestPath={setHBaseRestPath}
                connectionMode={hbaseConnectionMode} setConnectionMode={setHBaseConnectionMode}
                zkQuorum={hbaseZkQuorum} setZkQuorum={setHBaseZkQuorum}
                zkRoot={hbaseZkRoot} setZkRoot={setHBaseZkRoot}
                effectiveUser={hbaseEffectiveUser} setEffectiveUser={setHBaseEffectiveUser}
                ssl={dbSsl} setSsl={setDbSsl}
                timeoutSecs={dbTimeout} setTimeoutSecs={setDbTimeout}
                authMethod={hbaseAuthMethod} setAuthMethod={setHBaseAuthMethod}
                servicePrincipal={hbaseServicePrincipal} setServicePrincipal={setHBaseServicePrincipal}
                principal={hbasePrincipal} setPrincipal={setHBasePrincipal}
                keytabPath={hbaseKeytabPath} setKeytabPath={setHBaseKeytabPath}
                krb5ConfPath={hbaseKrb5ConfPath} setKrb5ConfPath={setHBaseKrb5ConfPath}
                hbaseSitePath={hbaseSitePath} setHBaseSitePath={setHBaseSitePath}
              />
            </div>
          )}
          {activeSection === "objectstorage" && isObjectStorage && (
            <div data-testid="session-objectstorage-wrap">
              <ObjectStorageSettings
                value={oss}
                onChange={setOss}
                saveInVault={saveInVault}
                setSaveInVault={setSaveInVault}
              />
            </div>
          )}
          {activeSection === "proxy" && isProxy && (
            <div data-testid="session-proxy-section" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
              <Field label={t("sessionEditor2.proxyKindLabel")}>
                <Select
                  value={proxyKind === "http" ? t("sessionEditor2.proxyHttp") : t("sessionEditor2.proxySocks5")}
                  options={[t("sessionEditor2.proxyHttp"), t("sessionEditor2.proxySocks5")]}
                  onChange={(label) => setProxyKind(label === t("sessionEditor2.proxyHttp") ? "http" : "socks5")}
                />
              </Field>
              <Field label={t("sessionEditor2.proxyTestUrl")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.proxyTestUrlPlaceholder")}
                  value={proxyTestUrl}
                  onChange={(e) => setProxyTestUrl(e.target.value)}
                />
              </Field>
            </div>
          )}
          {activeSection === "network" && !isDb && !isObjectStorage && (
            <NetworkSettings
              t={t}
              value={networkSettings}
              onChange={setNetworkSettings}
              sessionConfigId={session?.id}
              sshSessions={sessions
                .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              proxySessions={sessions
                .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              onSaveAsProxySession={() => void handleSaveAsProxySession()}
            />
          )}
          {activeSection === "network" && (isDb || isObjectStorage) && (
            <DbNetworkSettings
              t={t}
              value={networkSettings}
              onChange={setNetworkSettings}
              sshSessions={sessions
                .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              proxySessions={sessions
                .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              onSaveAsProxySession={() => void handleSaveAsProxySession()}
            />
          )}
          {activeSection === "bookmark" && (
            <BookmarkSettings
              t={t}
              name={name} setName={setName}
              groupPath={groupPath} setGroupPath={setGroupPath}
              folderOptions={folderOptions}
              description={description} setDescription={setDescription}
              tags={tags} setTags={setTags}
              proto={proto}
              onNewFolder={handleNewFolder}
              fileEmbedInTab={fileEmbedInTab} setFileEmbedInTab={setFileEmbedInTab}
              fileExtraArgs={fileExtraArgs} setFileExtraArgs={setFileExtraArgs}
              disableAiWrite={disableAiWrite} setDisableAiWrite={setDisableAiWrite}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="h-12 flex items-center px-3 gap-2 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          {isSSH && needsHost && (
            <button
              className="taomni-btn flex items-center gap-1.5"
              onClick={handleTestConnection}
              disabled={testing}
              type="button"
              aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
            </button>
          )}
          {isDb && (
            <button
              className="taomni-btn flex items-center gap-1.5"
              data-testid="db-test-connection"
              onClick={() => void handleTestDbConnection()}
              disabled={testing}
              type="button"
              aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
            </button>
          )}
          {isHBase && (
            <button
              className="taomni-btn flex items-center gap-1.5"
              data-testid="hbase-test-connection"
              onClick={() => void handleTestHBaseConnection()}
              disabled={testing}
              type="button"
              aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
            </button>
          )}
          {isProxy && (
            <button
              className="taomni-btn flex items-center gap-1.5"
              data-testid="proxy-test-connection"
              onClick={() => void handleTestProxyConnection()}
              disabled={testing}
              type="button"
              aria-label={testing ? t("sessionEditor2.proxyTestTesting") : t("sessionEditor2.proxyTestBtn")}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? t("sessionEditor2.proxyTestTesting") : t("sessionEditor2.proxyTestBtn")}{shortcuts.test}
            </button>
          )}
          <button className="taomni-btn flex items-center gap-1.5" type="button" onClick={() => void handleSaveTemplate()}>
            <Save className="w-3.5 h-3.5" /> {t("sessionEditor2.saveTemplate")}
          </button>
          <button className="taomni-btn flex items-center gap-1.5" type="button" onClick={handleReset}>
            <RotateCcw className="w-3.5 h-3.5" /> {t("sessionEditor2.reset")}
          </button>
          
          {(testResult || saveError) && (
            <span
              className="text-[11px]"
              style={{ color: testResult?.ok && !saveError ? "#2f8a3e" : "#b22222" }}
            >
              {saveError ?? testResult?.msg}
            </span>
          )}

          <span className="ml-2 text-[11px] text-[var(--taomni-text-muted)]">
            {t("sessionEditor2.willBeSavedTo")}{" "}
            <span className="taomni-mono">
              {groupPath ? folderOptionLabel(groupPath) : SESSION_ROOT_LABEL} / {name || host || "..."}
            </span>
          </span>

          <div className="flex-1" />

          {isEdit && (
            <button
              className="taomni-btn"
              onClick={handleDelete}
              type="button"
              style={{ color: "#b22222" }}
            >
              {t("sessionEditor2.delete")}
            </button>
          )}
          <button
            className="taomni-btn"
            onClick={onClose}
            type="button"
            aria-label={t("sessionEditor2.cancel")}
          >
            {t("sessionEditor2.cancel")}{shortcuts.cancel}
          </button>
          <button
            className="taomni-btn"
            data-testid="session-save"
            data-primary="true"
            onClick={handleSave}
            type="button"
            aria-label={t("sessionEditor2.ok")}
          >
            {t("sessionEditor2.ok")}{shortcuts.save}
          </button>
        </div>
      </div>
    </div>
  );
}

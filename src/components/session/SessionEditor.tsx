import { useEffect, useMemo, useState } from "react";
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
  Eye,
  EyeOff,
  FolderPlus,
  Save,
  RotateCcw,
  Network,
  HelpCircle,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import {
  selectFilePath,
  selectFolderPath,
  selectPrivateKeyFile,
  testSshConnection,
  vaultPut,
  isVaultReference,
  isVaultLockedError,
  listWslDistros,
  type WslDistro,
} from "../../lib/ipc";
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
import { WslOptionsForm } from "./forms/WslOptionsForm";
import { AppThemeSwitcher } from "../settings/AppThemeSwitcher";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";
import { useT, type TranslateFn } from "../../lib/i18n";

/* ------------------------------------------------------------------ */
/*  Local types                                                        */
/* ------------------------------------------------------------------ */

type Proto =
  | "SSH" | "Telnet" | "Rlogin" | "RDP" | "VNC" | "FTP" | "SFTP"
  | "Serial" | "File" | "Shell" | "Browser" | "Mosh" | "S3" | "WSL";

type SectionTab = "advanced" | "terminal" | "network" | "bookmark" | "rdp";

const PROTOS: { id: Proto; icon: React.ReactNode; color: string }[] = [
  { id: "SSH",     icon: <TerminalIcon className="w-7 h-7" />, color: "#2b5d8b" },
  { id: "Telnet",  icon: <TerminalIcon className="w-7 h-7" />, color: "#3b7ac2" },
  { id: "Rlogin",  icon: <TerminalIcon className="w-7 h-7" />, color: "#5b8a4a" },
  { id: "RDP",     icon: <Monitor className="w-7 h-7" />,      color: "#a04b9c" },
  { id: "VNC",     icon: <Monitor className="w-7 h-7" />,      color: "#c97a23" },
  { id: "FTP",     icon: <Folder className="w-7 h-7" />,       color: "#7a4f1a" },
  { id: "SFTP",    icon: <Folder className="w-7 h-7" />,       color: "#1e6db8" },
  { id: "Serial",  icon: <Wifi className="w-7 h-7" />,         color: "#236a98" },
  { id: "File",    icon: <FileText className="w-7 h-7" />,     color: "var(--moba-text-muted)" },
  { id: "Shell",   icon: <TerminalIcon className="w-7 h-7" />, color: "#62d36f" },
  { id: "Browser", icon: <Globe className="w-7 h-7" />,        color: "#1e5fa8" },
  { id: "Mosh",    icon: <Server className="w-7 h-7" />,       color: "#7a3d9d" },
  { id: "S3",      icon: <Cloud className="w-7 h-7" />,        color: "#cc6f00" },
  { id: "WSL",     icon: <TerminalIcon className="w-7 h-7" />, color: "#0078d4" },
];

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22, Telnet: 23, Rlogin: 513, RDP: 3389, VNC: 5900,
  FTP: 21, SFTP: 22, Serial: 0, File: 0, Shell: 0,
  Browser: 0, Mosh: 60001, S3: 443, WSL: 0,
};

/** Map UI proto to the backend session_type string. */
function protoToSessionType(p: Proto): string {
  const map: Partial<Record<Proto, string>> = {
    Rlogin: "Telnet", Shell: "LocalShell",
    Browser: "LocalShell", Mosh: "SSH", S3: "SFTP", WSL: "LocalShell",
  };
  return map[p] ?? p;
}

function sessionTypeToProto(type: string | undefined, optionsJson?: string | null): Proto {
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
      className="moba-checkbox"
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
      className="moba-radio"
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
        className={`moba-input pr-6 appearance-none ${className || "w-[260px]"}`}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--moba-text-muted)]" />
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
      <div className="col-span-3 text-[12px] text-right pt-1 text-[var(--moba-text)]">
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
  showPwd, setShowPwd,
  password, setPassword,
  passwordRef,
  clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  usePrivKey, setUsePrivKey,
  keyPath, setKeyPath,
  useJump, setUseJump,
  jumpHost, setJumpHost,
  jumpUser, setJumpUser,
  jumpPort, setJumpPort,
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
  showPwd: boolean; setShowPwd: (v: boolean) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string;
  clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  usePrivKey: boolean; setUsePrivKey: (v: boolean) => void;
  keyPath: string; setKeyPath: (v: string) => void;
  useJump: boolean; setUseJump: (v: boolean) => void;
  jumpHost: string; setJumpHost: (v: string) => void;
  jumpUser: string; setJumpUser: (v: string) => void;
  jumpPort: string; setJumpPort: (v: string) => void;
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
          className="moba-input flex-1"
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
          <div className="flex items-center gap-2 pl-1">
            <span className="text-[var(--moba-text-muted)]">{t("sessionEditor2.passwordLabel")}</span>
            <div className="relative">
              <input
                className="moba-input pr-7"
                type={showPwd ? "text" : "password"}
                value={password}
                aria-label={t("sessionEditor2.passwordAria")}
                placeholder={passwordRef ? t("sessionEditor2.passwordPlaceholderSaved") : ""}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordRef) clearPasswordRef();
                }}
              />
              <button
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5"
                onClick={() => setShowPwd(!showPwd)}
                title={t("sessionEditor2.passwordShowHide")}
                type="button"
              >
                {showPwd
                  ? <EyeOff className="w-3.5 h-3.5 text-[var(--moba-text-muted)]" />
                  : <Eye className="w-3.5 h-3.5 text-[var(--moba-text-muted)]" />}
              </button>
            </div>
            <label
              className="flex items-center gap-1 text-[11px] cursor-pointer"
              title={
                vaultState === "empty"
                  ? t("sessionEditor2.saveInVaultTitleEmpty")
                  : t("sessionEditor2.saveInVaultTitleDefault")
              }
            >
              <input
                type="checkbox"
                className="moba-checkbox"
                data-testid="session-save-in-vault"
                checked={saveInVault}
                onChange={(e) => setSaveInVault(e.target.checked)}
                disabled={vaultState === "empty"}
              />
              {t("sessionEditor2.saveInVault")}
            </label>
            <span className="moba-pill">
              <Shield className="w-3 h-3" /> {t("sessionEditor2.encryptedPill")}
            </span>
          </div>
        </div>
      </Field>

      <Field label={t("sessionEditor2.fieldPrivateKey")}>
        <Checkbox checked={usePrivKey} onChange={setUsePrivKey} />
        <input
          className="moba-input flex-1 ml-2"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          disabled={!usePrivKey}
          aria-label={t("sessionEditor2.privateKeyAria")}
          placeholder={t("sessionEditor2.privateKeyPlaceholder")}
        />
        <button className="moba-btn ml-1" disabled={!usePrivKey} onClick={onBrowseKey} type="button">
          {t("sessionEditor2.browse")}
        </button>
        <button className="moba-btn ml-1" disabled type="button" title={t("sessionEditor2.generateTitle")}>
          {t("sessionEditor2.generate")}
        </button>
      </Field>

      <Field label={t("sessionEditor2.fieldJumpHost")}>
        <div className="flex flex-col gap-1.5 w-full">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={useJump} onChange={setUseJump} /> {t("sessionEditor2.enableJumpHost")}
          </label>
          <div
            className="flex items-center gap-2 pl-1"
            style={{ opacity: useJump ? 1 : 0.5 }}
          >
            <span className="text-[var(--moba-text-muted)] w-16 text-right">{t("sessionEditor2.jumpGateway")}</span>
            <input
              className="moba-input w-56"
              value={jumpHost}
              onChange={(e) => setJumpHost(e.target.value)}
              disabled={!useJump}
              aria-label={t("sessionEditor2.jumpHostAria")}
            />
            <span className="text-[var(--moba-text-muted)]">{t("sessionEditor2.jumpUserLabel")}</span>
            <input
              className="moba-input w-32"
              value={jumpUser}
              onChange={(e) => setJumpUser(e.target.value)}
              disabled={!useJump}
              aria-label={t("sessionEditor2.jumpUserAria")}
            />
            <span className="text-[var(--moba-text-muted)]">{t("sessionEditor2.jumpPortLabel")}</span>
            <input
              className="moba-input w-16"
              value={jumpPort}
              onChange={(e) => setJumpPort(e.target.value)}
              disabled={!useJump}
              aria-label={t("sessionEditor2.jumpPortAria")}
            />
            <button className="moba-btn" disabled type="button" title={t("sessionEditor2.testChainTitle")}>
              {t("sessionEditor2.testChain")}
            </button>
          </div>
        </div>
      </Field>

      <Field label={t("sessionEditor2.fieldExpertSsh")}>
        <button className="moba-btn" type="button" disabled title={t("sessionEditor2.expertTitle")}>{t("sessionEditor2.openExpertSettings")}</button>
        <span className="ml-2 text-[var(--moba-text-muted)]">
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

function NetworkSettings({
  t,
  value,
  onChange,
  sessionConfigId,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  /** When set, the Network tab subscribes to runtime forward errors
   *  for this saved session and renders the latest failure inline next
   *  to the offending row. */
  sessionConfigId?: string;
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
    window.addEventListener("newmob:forward-error", onErr as EventListener);
    return () => window.removeEventListener("newmob:forward-error", onErr as EventListener);
  }, [sessionConfigId]);

  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const proxy = proxyKindToLabel(value.proxyKind);
  const proxyHost = value.proxyHost;
  const proxyPort = value.proxyPort;
  const proxyUser = value.proxyUser;
  const proxyPass = value.proxyPass;
  const proxySave = value.proxySaveAuth;
  const keepAlive = value.keepAlive;
  const keepAliveInterval = value.keepAliveIntervalSecs;
  const tcpNodelay = value.tcpNodelay;
  const disableNagle = value.disableNagle;
  const ipVersion = ipKindToLabel(value.ipVersion);
  const forwards = value.localForwards;

  const setProxy = (label: string) => patch({ proxyKind: proxyLabelToKind(label) });
  const setProxyHost = (v: string) => patch({ proxyHost: v });
  const setProxyPort = (v: string) => patch({ proxyPort: v });
  const setProxyUser = (v: string) => patch({ proxyUser: v });
  const setProxyPass = (v: string) => patch({ proxyPass: v });
  const setProxySave = (v: boolean) => patch({ proxySaveAuth: v });
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
      <Field label={t("sessionEditor2.fieldProxy")}>
        <Select
          value={proxy}
          options={[
            t("sessionEditor2.proxyNone"),
            t("sessionEditor2.proxyHttp"),
            t("sessionEditor2.proxySocks4"),
            t("sessionEditor2.proxySocks5"),
            t("sessionEditor2.proxyLocalSshTunnel"),
            t("sessionEditor2.proxySystem"),
          ]}
          onChange={setProxy}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldProxyHost")}>
        <input
          className="moba-input w-64"
          placeholder={t("sessionEditor2.proxyHostPlaceholder")}
          value={proxyHost}
          aria-label={t("sessionEditor2.proxyHostAria")}
          onChange={(e) => setProxyHost(e.target.value)}
        />
        <span className="text-[var(--moba-text-muted)] ml-2">{t("sessionEditor2.portLabel")}</span>
        <input
          className="moba-input w-16 ml-1"
          placeholder={t("sessionEditor2.proxyPortPlaceholder")}
          value={proxyPort}
          aria-label={t("sessionEditor2.proxyPortAria")}
          onChange={(e) => setProxyPort(e.target.value)}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldProxyAuth")}>
        <input
          className="moba-input w-32"
          placeholder={t("sessionEditor2.proxyUserPlaceholder")}
          value={proxyUser}
          aria-label={t("sessionEditor2.proxyUserAria")}
          onChange={(e) => setProxyUser(e.target.value)}
        />
        <input
          className="moba-input w-40 ml-1"
          type="password"
          placeholder={t("sessionEditor2.proxyPassPlaceholder")}
          value={proxyPass}
          aria-label={t("sessionEditor2.proxyPassAria")}
          onChange={(e) => setProxyPass(e.target.value)}
        />
        <label className="ml-2 flex items-center gap-1.5">
          <Checkbox checked={proxySave} onChange={setProxySave} /> {t("sessionEditor2.proxySaveInVault")}
        </label>
      </Field>

      <Field label={t("sessionEditor2.fieldKeepAlive")}>
        <label className="flex items-center gap-1.5">
          <Checkbox checked={keepAlive} onChange={setKeepAlive} />
          {t("sessionEditor2.keepAliveSend")}
        </label>
        <input
          className="moba-input w-16 ml-1"
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
          <div className="flex items-center gap-1.5 text-[var(--moba-text-muted)]">
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
                    className="moba-input w-32"
                    value={forward.local}
                    aria-label={t("sessionEditor2.forwardLocalAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, local: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="moba-input w-40"
                    value={forward.remote}
                    aria-label={t("sessionEditor2.forwardRemoteAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, remote: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="moba-input flex-1"
                    value={forward.desc}
                    aria-label={t("sessionEditor2.forwardDescAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, desc: e.target.value } : item),
                      )
                    }
                  />
                  <button className="moba-btn" type="button" onClick={() => setForwards((items) => items.filter((item) => item.id !== forward.id))}>
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
            <input className="moba-input w-32" placeholder={t("sessionEditor2.forwardLocalPlaceholder")} value={newFwdLocal} aria-label={t("sessionEditor2.forwardLocalNewAria")} onChange={(e) => setNewFwdLocal(e.target.value)} />
            <input className="moba-input w-40" placeholder={t("sessionEditor2.forwardRemotePlaceholder")} value={newFwdRemote} aria-label={t("sessionEditor2.forwardRemoteNewAria")} onChange={(e) => setNewFwdRemote(e.target.value)} />
            <input className="moba-input flex-1" placeholder={t("sessionEditor2.forwardDescPlaceholder")} value={newFwdDesc} aria-label={t("sessionEditor2.forwardDescNewAria")} onChange={(e) => setNewFwdDesc(e.target.value)} />
            <button className="moba-btn" type="button" onClick={addForward} disabled={!newFwdLocal.trim() || !newFwdRemote.trim()}>{t("sessionEditor2.forwardAdd")}</button>
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

  return (
    <div data-testid="bookmark-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label={t("sessionEditor2.fieldSessionName")}>
        <input
          data-testid="session-name"
          className="moba-input w-72"
          value={name}
          aria-label={t("sessionEditor2.sessionNameAria")}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="ml-2 text-[var(--moba-text-muted)]">{t("sessionEditor2.sessionNameHint")}</span>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionFolder")}>
        <Select
          value={groupPath || "User sessions"}
          className="w-[260px]"
          options={folderOptions}
          onChange={(value) => setGroupPath(value === "User sessions" ? "" : value)}
        />
        <button className="moba-btn ml-2 flex items-center gap-1" type="button" onClick={onNewFolder}>
          <FolderPlus className="w-3 h-3" /> {t("sessionEditor2.newFolderBtn")}
        </button>
      </Field>

      <Field label={t("sessionEditor2.fieldSessionIcon")}>
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded border"
          style={{ borderColor: "var(--moba-input-border)", background: "var(--moba-input-bg)" }}
        >
          <TerminalIcon className="w-4 h-4" style={{ color: "#2b5d8b" }} />
          {proto.toLowerCase()}
        </span>
        <button className="moba-btn ml-2" type="button" disabled title={t("sessionEditor2.customIconTitle")}>{t("sessionEditor2.customIconChange")}</button>
      </Field>

      <Field label={t("sessionEditor2.fieldBackgroundImage")}>
        <input
          className="moba-input flex-1"
          placeholder={t("sessionEditor2.backgroundImagePlaceholder")}
          value={bgImage}
          aria-label={t("sessionEditor2.backgroundImageAria")}
          onChange={(e) => setBgImage(e.target.value)}
        />
        <button className="moba-btn ml-1" type="button" disabled title={t("sessionEditor2.backgroundImageTitle")}>{t("sessionEditor2.backgroundImageBrowse")}</button>
        <span className="ml-2 text-[var(--moba-text-muted)]">{t("sessionEditor2.backgroundImageOpacity")}</span>
        <input
          className="moba-input w-16 ml-1"
          value={bgOpacity}
          aria-label={t("sessionEditor2.backgroundOpacityAria")}
          onChange={(e) => setBgOpacity(e.target.value)}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldDescriptionNotes")}>
        <textarea
          className="moba-input flex-1"
          style={{ height: 56, padding: 6 }}
          value={description}
          aria-label={t("sessionEditor2.descriptionAria")}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("sessionEditor2.descriptionPlaceholder")}
        />
      </Field>

      <Field label={t("sessionEditor2.fieldTags")}>
        <input
          className="moba-input flex-1"
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
        <span className="ml-2 text-[var(--moba-text-muted)]">
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
              className="moba-input flex-1"
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
          className="moba-input w-40"
          value={shortcut}
          aria-label={t("sessionEditor2.keyboardShortcutAria")}
          onChange={(e) => setShortcut(e.target.value)}
          placeholder={t("sessionEditor2.keyboardShortcutPlaceholder")}
        />
        <span className="ml-2 text-[var(--moba-text-muted)]">
          {t("sessionEditor2.keyboardShortcutHint")}
        </span>
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
  const [showPwd, setShowPwd] = useState(false);
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
  const [useJump, setUseJump] = useState(() => optionBoolean(initialOptions, "useJump", false));
  const [jumpHost, setJumpHost] = useState(() => optionString(initialOptions, "jumpHost", ""));
  const [jumpUser, setJumpUser] = useState(() => optionString(initialOptions, "jumpUser", ""));
  const [jumpPort, setJumpPort] = useState(() => optionString(initialOptions, "jumpPort", "22"));

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
  const needsHost = !["Serial", "File", "Shell", "WSL"].includes(proto);
  const isSSH = ["SSH", "SFTP"].includes(proto);
  const isRdp = proto === "RDP";
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
  }: {
    passwordRefValue?: string;
    networkSettingsValue?: NetworkSettingsValue;
    proxyPassValue?: string;
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

    return JSON.stringify({
      ...previousOptions,
      x11, x11Trusted, compression, startupCmd, jumpHost: jumpHost || "",
      jumpUser, jumpPort, description, tags, doNotExit, disableAiWrite,
      remoteEnv, sshBrowser, usePrivKey, useJump,
      fileEmbedInTab, fileExtraArgs,
      terminalProfile,
      // SSH password vault reference (vault:<id>). Empty string means no
      // saved password; the user types it on connect.
      passwordRef: passwordRefValue || "",
      // Strip the proxy password unless the user explicitly opted into
      // "Save in vault". `options_json` lands in the SQLite session row
      // in plaintext, so this is the gate keeping secrets out at rest.
      // When proxySaveAuth is on AND the value is already a vault: ref,
      // we keep it (the resolution happens server-side).
      networkSettings: networkSettingsValue.proxySaveAuth
        ? { ...networkSettingsValue, proxyPass: proxyPassValue }
        : { ...networkSettingsValue, proxyPass: "" },
      ...wslOverrides,
      ...rdpOverrides,
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
        : (proto === "File" && host
          ? (host.split(/[\\/]/).filter(Boolean).pop() || host)
          : (host ? `${username ? username + "@" : ""}${host}` : "Local terminal")));
    return {
      id: session?.id ?? crypto.randomUUID(),
      name: displayName,
      session_type: protoToSessionType(proto),
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
    if (isSSH && specifyUser && !username.trim()) return t("sessionEditor2.errUsernameEmpty");
    if (authMethod === "PrivateKey" && !keyPath.trim()) return t("sessionEditor2.errKeyPathRequired");
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError(null);

    // If the user wants to remember the SSH password and typed a fresh
    // plaintext into the password field, push it into the vault first and
    // capture the resulting `vault:<id>` reference. We do this *before*
    // building the config so the reference lands in options_json.
    let nextPasswordRef = passwordRef;
    if (
      isSSH &&
      authMethod === "Password" &&
      saveInVault &&
      vaultState !== "empty" &&
      password.length > 0
    ) {
      try {
        const label = `${username || "user"}@${host || "?"}:${port}`;
        const result = await vaultPut("ssh-password", label, password);
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
      vaultState !== "empty" &&
      networkSettings.proxyPass.length > 0 &&
      !isVaultReference(networkSettings.proxyPass)
    ) {
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

    setPasswordRef(nextPasswordRef);
    const config = buildConfig({
      options_json: buildOptionsJson({
        passwordRefValue: nextPasswordRef,
        proxyPassValue: nextProxyPass,
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
    setShowPwd(false);
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
    setUseJump(optionBoolean(nextOptions, "useJump", false));
    setJumpHost(optionString(nextOptions, "jumpHost", ""));
    setJumpUser(optionString(nextOptions, "jumpUser", ""));
    setJumpPort(optionString(nextOptions, "jumpPort", "22"));
    setDescription(optionString(nextOptions, "description", ""));
    setTags(optionString(nextOptions, "tags", ""));
    setFileEmbedInTab(optionBoolean(nextOptions, "fileEmbedInTab", true));
    setFileExtraArgs(optionString(nextOptions, "fileExtraArgs", ""));
    setTerminalProfile(getSessionTerminalProfile(session?.options_json) ?? loadGlobalTerminalProfile());
    setNetworkSettings(getSessionNetworkSettings(session?.options_json));
    setWslOptions(parseWslOptions(session?.options_json));
    setRdpOptions(parseRdpOptions(session?.options_json));
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

  const handleNewFolder = () => {
    const next = window.prompt(t("sessionEditor2.promptNewFolder"), groupPath || t("sessionEditor2.promptNewFolderDefault"));
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

  const sectionTabs: { id: SectionTab; label: string; icon: React.ReactNode }[] = proto === "File"
    ? [
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : [
        ...(isSSH
          ? [{ id: "advanced" as SectionTab, label: t("sessionEditor2.sectionAdvancedSsh"), icon: <Shield className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
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
   * off the rdp tab. */
  const activeSection =
    proto === "File"
      ? "bookmark"
      : section === "advanced" && !isSSH
        ? (isRdp ? "rdp" : "terminal")
        : section === "rdp" && !isRdp
          ? "terminal"
          : section === "terminal" && isRdp
            ? "rdp"
            : section;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        data-testid="session-editor"
        className="w-[1020px] max-w-[96%] max-h-[92vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--moba-panel-bg)", borderColor: "var(--moba-chrome-border)", color: "var(--moba-text)" }}
      >
        {/* Modal title bar */}
        <div
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0"
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
            <AppThemeSwitcher compact />
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
          style={{ borderColor: "var(--moba-divider)" }}
        >
          <div className="flex flex-wrap gap-1">
            {PROTOS.map((p) => (
              <button
                key={p.id}
                data-testid={`session-proto-${p.id.toLowerCase()}`}
                className="moba-proto-btn"
                data-active={proto === p.id}
                onClick={() => handleProtoChange(p.id)}
                type="button"
              >
                <span
                  style={{
                    color: proto === p.id ? "var(--moba-accent)" : p.color,
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
            style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--moba-accent)" }}
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
                  className="moba-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={handleHostLookup}
                  aria-label={t("sessionEditor2.remoteHostAria")}
                  placeholder={t("sessionEditor2.remoteHostPlaceholder")}
                />
                <button
                  title={t("sessionEditor2.lookup")}
                  className="moba-btn px-2"
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
                className="moba-input col-span-2"
                value={username}
                disabled={!specifyUser}
                onChange={(e) => setUsername(e.target.value)}
                aria-label={t("sessionEditor2.usernameAria")}
                placeholder={t("sessionEditor2.usernamePlaceholder")}
              />

              <label className="col-span-2 text-[12px] text-right">{t("sessionEditor2.portLabel")}</label>
              <input
                data-testid="session-port"
                className="moba-input col-span-2"
                value={port}
                aria-label={t("sessionEditor2.portAria")}
                onChange={(e) => setPort(e.target.value)}
              />
              <div className="col-span-8 text-[11px] text-[var(--moba-text-muted)]">
                {(() => {
                  const tip = t("sessionEditor2.autofillTip", { snippet: "%SNIPPET%" });
                  const [before, after] = tip.split("%SNIPPET%");
                  return (
                    <>
                      {before}
                      <span
                        className="moba-mono px-1 border rounded"
                        style={{ background: "var(--moba-input-bg)", borderColor: "var(--moba-divider)" }}
                      >
                        user@host:port
                      </span>
                      {after}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Basic File settings — appears for the File protocol only */}
        {proto === "File" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--moba-accent)" }}
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
                  className="moba-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  aria-label={t("sessionEditor2.fileTargetAria")}
                  placeholder={t("sessionEditor2.fileTargetPlaceholder")}
                />
                <button
                  title={t("sessionEditor2.browseFolder")}
                  className="moba-btn px-2"
                  onClick={() => void handleBrowseFolderTarget()}
                  type="button"
                >
                  <Folder className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
                <button
                  title={t("sessionEditor2.browseFile")}
                  className="moba-btn px-2"
                  onClick={() => void handleBrowseFileTarget()}
                  type="button"
                >
                  <FileText className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
              </div>
              <div className="col-span-12 text-[11px] text-[var(--moba-text-muted)]">
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
            style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--moba-accent)" }}
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
              className="moba-section-tab"
              data-active={activeSection === t.id}
              onClick={() => setSection(t.id)}
              type="button"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <div className="flex-1 border-b" style={{ borderColor: "var(--moba-input-border)" }} />
        </div>

        {/* Section body */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x border-b"
          style={{ borderColor: "var(--moba-input-border)", background: "var(--moba-bg)" }}
        >
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
              showPwd={showPwd} setShowPwd={setShowPwd}
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
              useJump={useJump} setUseJump={setUseJump}
              jumpHost={jumpHost} setJumpHost={setJumpHost}
              jumpUser={jumpUser} setJumpUser={setJumpUser}
              jumpPort={jumpPort} setJumpPort={setJumpPort}
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
          {activeSection === "network" && (
            <NetworkSettings
              t={t}
              value={networkSettings}
              onChange={setNetworkSettings}
              sessionConfigId={session?.id}
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
          style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
        >
          {isSSH && needsHost && (
            <button
              className="moba-btn flex items-center gap-1.5"
              onClick={handleTestConnection}
              disabled={testing}
              type="button"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
            </button>
          )}
          <button className="moba-btn flex items-center gap-1.5" type="button" onClick={() => void handleSaveTemplate()}>
            <Save className="w-3.5 h-3.5" /> {t("sessionEditor2.saveTemplate")}
          </button>
          <button className="moba-btn flex items-center gap-1.5" type="button" onClick={handleReset}>
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

          <span className="ml-2 text-[11px] text-[var(--moba-text-muted)]">
            {t("sessionEditor2.willBeSavedTo")}{" "}
            <span className="moba-mono">
              {groupPath ? folderOptionLabel(groupPath) : SESSION_ROOT_LABEL} / {name || host || "..."}
            </span>
          </span>

          <div className="flex-1" />

          {isEdit && (
            <button
              className="moba-btn"
              onClick={handleDelete}
              type="button"
              style={{ color: "#b22222" }}
            >
              {t("sessionEditor2.delete")}
            </button>
          )}
          <button className="moba-btn" onClick={onClose} type="button">
            {t("sessionEditor2.cancel")}
          </button>
          <button
            className="moba-btn"
            data-testid="session-save"
            data-primary="true"
            onClick={handleSave}
            type="button"
          >
            {t("sessionEditor2.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

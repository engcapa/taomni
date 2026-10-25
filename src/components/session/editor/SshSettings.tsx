import { SshExpertSettings } from "./SshExpertSettings";
import type { NetworkSettings } from "../../../lib/networkSettings";
import { SshKeyGenerator } from "./SshKeyGenerator";
import { remoteEnvironment } from "../../../lib/sshSessionOptions";
import { Shield } from "lucide-react";
import { type TranslateFn } from "../../../lib/i18n";
import { Field, Checkbox, Select, Radio } from "./Fields";


/* ------------------------------------------------------------------ */
/*  Sub-panels                                                         */
/* ------------------------------------------------------------------ */

export function AdvancedSshSettings({
  networkSettings, setNetworkSettings,
  t,
  sessionType = "SSH",
  x11, setX11,
  x11Trusted, setX11Trusted,
  compression, setCompression,
  startupCmd, setStartupCmd,
  doNotExit, setDoNotExit,
  remoteEnv, setRemoteEnv,
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
  networkSettings: NetworkSettings;
  setNetworkSettings: (value: NetworkSettings) => void;
  t: TranslateFn;
  sessionType?: string;
  x11: boolean; setX11: (v: boolean) => void;
  x11Trusted: boolean; setX11Trusted: (v: boolean) => void;
  compression: boolean; setCompression: (v: boolean) => void;
  startupCmd: string; setStartupCmd: (v: string) => void;
  doNotExit: boolean; setDoNotExit: (v: boolean) => void;
  remoteEnv: string; setRemoteEnv: (v: string) => void;
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
      {sessionType === "SSH" && <Field label={t("sessionEditor2.fieldX11")}>
        <label className="flex items-center gap-1.5">
          <Checkbox dataTestId="session-x11-forwarding-toggle" checked={x11} onChange={setX11} />
          {t("sessionEditor2.enable")}
        </label>
        <label className={`flex items-center gap-1.5 ml-3 ${x11 ? "" : "opacity-50"}`} title={t("sessionEditor2.x11TrustedHint")}>
          <Checkbox dataTestId="session-x11-trusted-toggle" checked={x11Trusted} onChange={setX11Trusted} disabled={!x11} />
          {t("sessionEditor2.x11Trusted")}
        </label>
      </Field>}

      <Field label={t("sessionEditor2.fieldCompression")}>
        <label className="flex items-center gap-1.5">
          <Checkbox dataTestId="session-compression-toggle" checked={compression} onChange={setCompression} />
          {t("sessionEditor2.compressionLabel")}
        </label>
      </Field>

      {sessionType === "SSH" && <Field label={t("sessionEditor2.fieldRemoteEnvironment")}>
        <Select
          dataTestId="session-remote-environment"
          value={remoteEnvironment(remoteEnv)}
          options={[
            { value: "shell", label: t("sessionEditor2.remoteEnvInteractive") },
            { value: "lxde", label: t("sessionEditor2.remoteEnvLxde") },
            { value: "xfce", label: t("sessionEditor2.remoteEnvXfce") },
            { value: "gnome", label: t("sessionEditor2.remoteEnvGnome") },
            { value: "kde", label: t("sessionEditor2.remoteEnvKde") },
            { value: "awesome", label: t("sessionEditor2.remoteEnvAwesome") },
            { value: "custom", label: t("sessionEditor2.remoteEnvCustom") },
          ]}
          onChange={(value) => {
            setRemoteEnv(value);
            if (value !== "shell" && value !== "custom") setX11(true);
          }}
        />
      </Field>}

      {sessionType === "SSH" && <Field label={t("sessionEditor2.fieldExecuteCommand")}>
        <input
          className="taomni-input flex-1"
          placeholder={t("sessionEditor2.executeCommandPlaceholder")}
          value={startupCmd}
          aria-label={t("sessionEditor2.executeCommandAria")}
          onChange={(e) => setStartupCmd(e.target.value)}
        />
        <label className="ml-2 flex items-center gap-1.5">
          <Checkbox dataTestId="session-do-not-exit" checked={doNotExit} onChange={setDoNotExit} />
          {t("sessionEditor2.doNotExit")}
        </label>
      </Field>}

      {sessionType === "SSH" && <Field label={t("sessionEditor2.fieldSshBrowserType")}>
        <span data-testid="session-ssh-browser-type">{t("sessionEditor2.sshBrowserSftp")}</span>
      </Field>}

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
                  dataTestId={`session-auth-${val}`}
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
        <Checkbox dataTestId="session-private-key-toggle" checked={usePrivKey} onChange={setUsePrivKey} />
        <input
          className="taomni-input flex-1 ml-2"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          disabled={!usePrivKey}
          aria-label={t("sessionEditor2.privateKeyAria")}
          placeholder={t("sessionEditor2.privateKeyPlaceholder")}
        />
        <button data-testid="session-private-key-browse" className="taomni-btn ml-1" disabled={!usePrivKey} onClick={onBrowseKey} type="button">
          {t("sessionEditor2.browse")}
        </button>
        <SshKeyGenerator onGenerated={(path) => { setAuthRadio("privatekey"); setKeyPath(path); }} />
      </Field>

      <Field label={t("sessionEditor2.fieldExpertSsh")}>
        <SshExpertSettings value={networkSettings} onChange={setNetworkSettings} />
      </Field>
    </div>
  );
}

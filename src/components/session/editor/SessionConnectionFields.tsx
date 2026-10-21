import { type ClipboardEvent } from "react";
import { Terminal as TerminalIcon, Shield, Search } from "lucide-react";
import { type Proto } from "./sessionPolicy";
import { Checkbox } from "./Fields";


export interface SessionConnectionFieldsProps {
  t: import("../../../lib/i18n").TranslateFn;
  proto: Proto;
  host: string;
  setHost: import("react").Dispatch<import("react").SetStateAction<string>>;
  handleHostPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  handleHostLookup: () => void;
  specifyUser: boolean;
  setSpecifyUser: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  username: string;
  setUsername: import("react").Dispatch<import("react").SetStateAction<string>>;
  port: string;
  setPort: import("react").Dispatch<import("react").SetStateAction<string>>;
  isProxy: boolean;
  isMail: boolean;
  password: string;
  passwordRef: string;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  vaultState: import("../../../lib/ipc").VaultStateKind;
  saveInVault: boolean;
  setSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}

export function SessionConnectionFields(viewProps: SessionConnectionFieldsProps) {
  const { handleHostLookup, handleHostPaste, host, isMail, isProxy, password, passwordRef, port, proto, saveInVault, setHost, setPassword, setPasswordRef, setPort, setSaveInVault, setSpecifyUser, setUsername, specifyUser, t, username, vaultState } = viewProps;
 return (<div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {t("sessionEditor2.basicTitle", { proto: proto })}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                {proto === "Browser" ? t("sessionEditor2.browserUrl") : t("sessionEditor2.remoteHost")}
              </label>
              <div className="col-span-5 flex items-center gap-1">
                <input
                  data-testid="session-host"
                  className="taomni-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onPaste={proto === "Browser" ? undefined : handleHostPaste}
                  onBlur={proto === "Browser" ? undefined : handleHostLookup}
                  aria-label={proto === "Browser" ? t("sessionEditor2.browserUrl") : t("sessionEditor2.remoteHostAria")}
                  placeholder={proto === "Browser" ? t("sessionEditor2.browserUrlPlaceholder") : t("sessionEditor2.remoteHostPlaceholder")}
                />
                <button
                  data-testid="session-host-lookup"
                  title={t("sessionEditor2.lookup")}
                  className="taomni-btn px-2"
                  onClick={handleHostLookup}
                  type="button"
                >
                  <Search className="w-3 h-3 inline -mt-0.5" />
                </button>
              </div>
              <label className="col-span-3 text-[12px] flex items-center gap-1.5 justify-end">
                <Checkbox checked={specifyUser} onChange={setSpecifyUser} dataTestId="session-specify-username" />
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
                        ssh -p 2222 user@host
                      </span>
                      {after}
                    </>
                  );
                })()}
              </div>

              {(proto === "RDP" || proto === "VNC" || isProxy || isMail) && (
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
                        aria-label={isMail ? "Mail password or app password token" : t("sessionEditor2.passwordLabel")}
                        placeholder={passwordRef ? t("sessionEditor2.passwordPlaceholderSaved") : isMail ? "Password / app password token" : ""}
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
          </div>);
}

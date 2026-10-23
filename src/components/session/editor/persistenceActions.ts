import { sessionCapabilities } from "../../../lib/sessionCapabilities";
import { ensureVaultReady } from "../../../lib/vaultGate";
import { vaultPut, isVaultReference, isVaultLockedError } from "../../../lib/ipc";
import { type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import { normalizeGroupPath, toStoredGroupPath } from "../../../lib/sessionPaths";
import { confirmAppDialog, promptAppDialog } from "../../../lib/appDialogs";
import type { SessionConfig } from "../../../lib/ipc";
import { ossFormToConfig, type OssFormState } from "../ObjectStorageSettings";
import { engineForProvider } from "../../../types/objectStorage";
import { type Proto } from "./sessionPolicy";
import { type MailProvider, type MailAuthMode, type MailOAuthFlow, effectiveMailOAuthFlow, mailOAuthClientSecretVisible } from "./mailPolicy";


export interface HandleSaveContext {
  validate: () => string | null;
  setSaveError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  passwordRef: string;
  isSSH: boolean;
  isDb: boolean;
  isHBase: boolean;
  proto: Proto;
  isProxy: boolean;
  isMail: boolean;
  authMethod: "Password" | "Agent" | "Gssapi" | "None" | "PrivateKey";
  mailAuthMode: MailAuthMode;
  saveInVault: boolean;
  password: string;
  t: import("../../../lib/i18n").TranslateFn;
  username: string;
  host: string;
  port: string;
  setPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  networkSettings: NetworkSettingsValue;
  setNetworkSettings: import("react").Dispatch<import("react").SetStateAction<NetworkSettingsValue>>;
  mailSmtpPasswordRef: string;
  mailSmtpUseImapAuth: boolean;
  mailSmtpSaveInVault: boolean;
  mailSmtpPassword: string;
  mailSmtpUsername: string;
  mailSmtpHost: string;
  mailSmtpPort: string;
  setMailSmtpPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  setMailSmtpPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  mailOauthClientSecretRef: string;
  mailProvider: MailProvider;
  mailOauthFlow: MailOAuthFlow;
  setMailOauthClientSecretRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  setMailOauthClientSecret: import("react").Dispatch<import("react").SetStateAction<string>>;
  mailOauthClientSecretSaveInVault: boolean;
  mailOauthClientSecret: string;
  oss: OssFormState;
  setOss: import("react").Dispatch<import("react").SetStateAction<OssFormState>>;
  buildConfig: (overrides?: Partial<SessionConfig>) => SessionConfig;
  buildOptionsJson: ({ passwordRefValue, networkSettingsValue, proxyPassValue, jumpPasswordValue, mailSmtpPasswordRefValue, mailOauthClientSecretRefValue, mailOauthTokenRefValue, mailOauthExpiresAtValue, mailOauthScopeValue, ossConfigValue, }?: { passwordRefValue?: string; networkSettingsValue?: NetworkSettingsValue; proxyPassValue?: string; jumpPasswordValue?: string; mailSmtpPasswordRefValue?: string; mailOauthClientSecretRefValue?: string; mailOauthTokenRefValue?: string; mailOauthExpiresAtValue?: string; mailOauthScopeValue?: string; ossConfigValue?: Record<string, unknown>; }) => string;
  mailOauthTokenRef: string;
  mailOauthExpiresAt: string;
  mailOauthScope: string;
  isEdit: boolean;
  updateSession: (config: SessionConfig) => Promise<void>;
  addSession: (config: SessionConfig) => Promise<void>;
  onClose: () => void;
}


export function createHandleSave(controllerContext: HandleSaveContext): () => Promise<void> {
  return async () => {
    const error = controllerContext.validate();
    if (error) {
      controllerContext.setSaveError(error);
      return;
    }
    controllerContext.setSaveError(null);

    // If the user wants to remember the SSH/database password and typed a
    // fresh plaintext into the password field, push it into the vault first
    // and capture the resulting `vault:<id>` reference. We do this *before*
    // building the config so the reference lands in options_json.
    let nextPasswordRef = controllerContext.passwordRef;
    if (
      (controllerContext.isSSH || controllerContext.isDb || controllerContext.isHBase || controllerContext.proto === "RDP" || controllerContext.proto === "VNC" || controllerContext.isProxy || controllerContext.isMail) &&
      (controllerContext.isDb || controllerContext.isHBase || controllerContext.proto === "RDP" || controllerContext.proto === "VNC" || controllerContext.isProxy || controllerContext.isMail || controllerContext.authMethod === "Password") &&
      (!controllerContext.isMail || controllerContext.mailAuthMode === "password") &&
      controllerContext.saveInVault &&
      controllerContext.password.length > 0
    ) {
      // The vault must be unlocked to encrypt the password. If it is empty or
      // locked, pop the on-demand gate (set master password / unlock) instead
      // of failing with a text hint. Bail out of the save if the user cancels.
      const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonSession"));
      if (!ready) {
        controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
        return;
      }
      try {
        const kind =
          controllerContext.proto === "RDP"
            ? "rdp-password"
            : controllerContext.proto === "VNC"
              ? "vnc-password"
            : controllerContext.isProxy
              ? "proxy-password"
              : controllerContext.isMail
                ? "mail-imap-password"
              : controllerContext.isHBase
                  ? "hbase-password"
                  : controllerContext.isDb
                    ? "db-password"
                    : "ssh-password";
        const label = `${controllerContext.username || "user"}@${controllerContext.host || "?"}:${controllerContext.port}`;
        const result = await vaultPut(kind, label, controllerContext.password);
        nextPasswordRef = result.reference;
        controllerContext.setPasswordRef(result.reference);
        controllerContext.setPassword("");
      } catch (err) {
        if (isVaultLockedError(err)) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
        } else {
          controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    } else if (!controllerContext.saveInVault) {
      // User unchecked Save in vault: forget any previous reference.
      nextPasswordRef = "";
    }
    if (controllerContext.isMail && controllerContext.mailAuthMode === "oauth2") {
      nextPasswordRef = "";
      controllerContext.setPasswordRef("");
      controllerContext.setPassword("");
    }

    // Same dance for the proxy password when proxySaveAuth is enabled and
    // the user typed a fresh plaintext (i.e. the value isn't already a
    // vault: reference).
    let nextProxyPass = controllerContext.networkSettings.proxyPass;
    if (
      sessionCapabilities(controllerContext.proto).network &&
      ["http", "socks5"].includes(controllerContext.networkSettings.proxyKind) &&
      controllerContext.networkSettings.proxySaveAuth &&
      controllerContext.networkSettings.proxyPass.length > 0 &&
      !isVaultReference(controllerContext.networkSettings.proxyPass)
    ) {
      const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonProxy"));
      if (!ready) {
        controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `proxy://${controllerContext.networkSettings.proxyHost}:${controllerContext.networkSettings.proxyPort}`;
        const result = await vaultPut("proxy-password", label, controllerContext.networkSettings.proxyPass);
        nextProxyPass = result.reference;
        controllerContext.setNetworkSettings({ ...controllerContext.networkSettings, proxyPass: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedProxy"));
        } else {
          controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // And once more for the SSH jump-host password (manual mode only — when a
    // jump session is selected, its own saved credential is resolved
    // server-side and there is no separate jump password to persist).
    let nextJumpPass = controllerContext.networkSettings.jumpPassword;
    if (
      sessionCapabilities(controllerContext.proto).network &&
      controllerContext.networkSettings.proxyKind === "ssh-tunnel" &&
      controllerContext.networkSettings.jumpSaveAuth &&
      controllerContext.networkSettings.jumpSessionId.trim() === "" &&
      controllerContext.networkSettings.jumpPassword.length > 0 &&
      !isVaultReference(controllerContext.networkSettings.jumpPassword)
    ) {
      const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonProxy"));
      if (!ready) {
        controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `jump://${controllerContext.networkSettings.jumpUser}@${controllerContext.networkSettings.jumpHost}:${controllerContext.networkSettings.jumpPort}`;
        const result = await vaultPut("jump-password", label, controllerContext.networkSettings.jumpPassword);
        nextJumpPass = result.reference;
        controllerContext.setNetworkSettings({ ...controllerContext.networkSettings, jumpPassword: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedProxy"));
        } else {
          controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    controllerContext.setPasswordRef(nextPasswordRef);

    let nextMailSmtpPasswordRef = controllerContext.mailSmtpPasswordRef;
    if (controllerContext.isMail && controllerContext.mailAuthMode === "password" && !controllerContext.mailSmtpUseImapAuth) {
      if (controllerContext.mailSmtpSaveInVault && controllerContext.mailSmtpPassword.length > 0) {
        const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonSession"));
        if (!ready) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const label = `${controllerContext.mailSmtpUsername || controllerContext.username || "mail"}@${controllerContext.mailSmtpHost || "smtp"}:${controllerContext.mailSmtpPort || "465"}`;
          const result = await vaultPut("mail-smtp-password", label, controllerContext.mailSmtpPassword);
          nextMailSmtpPasswordRef = result.reference;
          controllerContext.setMailSmtpPasswordRef(result.reference);
          controllerContext.setMailSmtpPassword("");
        } catch (err) {
          if (isVaultLockedError(err)) {
            controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          } else {
            controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else if (!controllerContext.mailSmtpSaveInVault) {
        nextMailSmtpPasswordRef = "";
      }
    } else if (controllerContext.isMail && (controllerContext.mailAuthMode === "oauth2" || controllerContext.mailSmtpUseImapAuth)) {
      nextMailSmtpPasswordRef = "";
      controllerContext.setMailSmtpPasswordRef("");
      controllerContext.setMailSmtpPassword("");
    }

    let nextMailOauthClientSecretRef = controllerContext.mailOauthClientSecretRef;
    const effectiveMailOauthFlowForSave = effectiveMailOAuthFlow(controllerContext.mailProvider, controllerContext.mailOauthFlow);
    if (controllerContext.isMail && controllerContext.mailAuthMode === "oauth2" && !mailOAuthClientSecretVisible(controllerContext.mailProvider, effectiveMailOauthFlowForSave)) {
      nextMailOauthClientSecretRef = "";
      controllerContext.setMailOauthClientSecretRef("");
      controllerContext.setMailOauthClientSecret("");
    } else if (controllerContext.isMail && controllerContext.mailAuthMode === "oauth2") {
      if (controllerContext.mailOauthClientSecretSaveInVault && controllerContext.mailOauthClientSecret.length > 0) {
        const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonSession"));
        if (!ready) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const label = `${controllerContext.username || "mail"} OAuth client secret`;
          const result = await vaultPut("mail-oauth-client-secret", label, controllerContext.mailOauthClientSecret);
          nextMailOauthClientSecretRef = result.reference;
          controllerContext.setMailOauthClientSecretRef(result.reference);
          controllerContext.setMailOauthClientSecret("");
        } catch (err) {
          if (isVaultLockedError(err)) {
            controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          } else {
            controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else if (!controllerContext.mailOauthClientSecretSaveInVault) {
        nextMailOauthClientSecretRef = "";
      }
    } else if (controllerContext.isMail) {
      nextMailOauthClientSecretRef = "";
      controllerContext.setMailOauthClientSecret("");
    }

    // Object-storage secrets: swap freshly-typed plaintext for vault refs when
    // "Save secrets in vault" is on. When off, secrets are stored as plaintext
    // in options_json (the backend resolve() accepts either form).
    let ossConfigValue: Record<string, unknown> | undefined;
    if (controllerContext.proto === "S3") {
      const isAzure = engineForProvider(controllerContext.oss.provider) === "azure";
      const label = controllerContext.oss.defaultBucket || controllerContext.oss.defaultContainer || controllerContext.oss.accountName || controllerContext.oss.endpoint || controllerContext.oss.provider;
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
        const value = controllerContext.oss[key] as string;
        if (!value || isVaultReference(value) || !controllerContext.saveInVault) {
          resolved[key] = value;
          continue;
        }
        const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonSession"));
        if (!ready) {
          controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const r = await vaultPut(kind, `${kind} ${label}`, value);
          resolved[key] = r.reference;
        } catch (err) {
          if (isVaultLockedError(err)) controllerContext.setSaveError(controllerContext.t("sessionEditor2.errVaultLockedSave"));
          else controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      const next: OssFormState = { ...controllerContext.oss, ...(resolved as Partial<OssFormState>) };
      controllerContext.setOss(next);
      ossConfigValue = { ...ossFormToConfig(next) };
    }

    const config = controllerContext.buildConfig({
      options_json: controllerContext.buildOptionsJson({
        passwordRefValue: nextPasswordRef,
        proxyPassValue: nextProxyPass,
        jumpPasswordValue: nextJumpPass,
        mailSmtpPasswordRefValue: nextMailSmtpPasswordRef,
        mailOauthClientSecretRefValue: nextMailOauthClientSecretRef,
        mailOauthTokenRefValue: controllerContext.mailAuthMode === "oauth2" ? controllerContext.mailOauthTokenRef : "",
        mailOauthExpiresAtValue: controllerContext.mailAuthMode === "oauth2" ? controllerContext.mailOauthExpiresAt : "",
        mailOauthScopeValue: controllerContext.mailAuthMode === "oauth2" ? controllerContext.mailOauthScope : "",
        ossConfigValue,
      }),
    });

    try {
      if (controllerContext.isEdit) {
        await controllerContext.updateSession(config);
      } else {
        await controllerContext.addSession(config);
      }
      controllerContext.onClose();
    } catch (err) {
      controllerContext.setSaveError(err instanceof Error ? err.message : String(err));
    }
  };
}



export interface HandleSaveTemplateContext {
  validate: () => string | null;
  setSaveError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  buildConfig: (overrides?: Partial<SessionConfig>) => SessionConfig;
  t: import("../../../lib/i18n").TranslateFn;
  name: string;
  host: string;
  proto: Proto;
  addSession: (config: SessionConfig) => Promise<void>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
}


export function createHandleSaveTemplate(controllerContext: HandleSaveTemplateContext): () => Promise<void> {
  return async () => {
    const error = controllerContext.validate();
    if (error) {
      controllerContext.setSaveError(error);
      return;
    }
    const config = controllerContext.buildConfig({
      id: crypto.randomUUID(),
      name: controllerContext.t("sessionEditor2.templateName", { base: controllerContext.name || controllerContext.host || controllerContext.proto }),
      group_path: "Templates",
      last_connected_at: null,
    });
    await controllerContext.addSession(config);
    controllerContext.setTestResult({ ok: true, msg: controllerContext.t("sessionEditor2.templateSaved") });
  };
}



export interface HandleNewFolderContext {
  t: import("../../../lib/i18n").TranslateFn;
  groupPath: string;
  setGroupPath: import("react").Dispatch<import("react").SetStateAction<string>>;
  createFolderPath: (path: string) => Promise<void>;
}


export function createHandleNewFolder(controllerContext: HandleNewFolderContext): () => Promise<void> {
  return async () => {
    const next = await promptAppDialog({
      title: controllerContext.t("sessionEditor2.promptNewFolder"),
      initialValue: controllerContext.groupPath || controllerContext.t("sessionEditor2.promptNewFolderDefault"),
      allowEmpty: true,
    });
    const normalized = normalizeGroupPath(next);
    if (!normalized) return;
    controllerContext.setGroupPath(toStoredGroupPath(normalized) ?? "");
    void controllerContext.createFolderPath(normalized);
  };
}



export interface HandleDeleteContext {
  session: SessionConfig | undefined;
  t: import("../../../lib/i18n").TranslateFn;
  removeSession: (id: string) => Promise<void>;
  onClose: () => void;
}


export function createHandleDelete(controllerContext: HandleDeleteContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.session) return;
    const confirmed = await confirmAppDialog({
      title: controllerContext.t("sessionEditor2.confirmDeleteTitle"),
      message: controllerContext.t("sessionEditor2.confirmDeleteMessage", { name: controllerContext.session.name }),
      confirmLabel: controllerContext.t("sessionEditor2.delete"),
      danger: true,
    });
    if (!confirmed) return;
    await controllerContext.removeSession(controllerContext.session.id);
    controllerContext.onClose();
  };
}



export interface HandleSaveAsProxySessionContext {
  networkSettings: NetworkSettingsValue;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  t: import("../../../lib/i18n").TranslateFn;
  addSession: (config: SessionConfig) => Promise<void>;
}


export function createHandleSaveAsProxySession(controllerContext: HandleSaveAsProxySessionContext): () => Promise<void> {
  return async () => {
    const ns = controllerContext.networkSettings;
    if (!ns.proxyHost.trim()) {
      controllerContext.setTestResult({ ok: false, msg: controllerContext.t("sessionEditor2.proxyHostRequired") });
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
        const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonProxy"));
        if (!ready) {
          controllerContext.setTestResult({ ok: false, msg: controllerContext.t("sessionEditor2.errVaultLockedProxy") });
          return;
        }
        try {
          const label = `proxy://${ns.proxyHost}:${proxyPort}`;
          const result = await vaultPut("proxy-password", label, ns.proxyPass);
          proxyPasswordRef = result.reference;
        } catch (err) {
          controllerContext.setTestResult({
            ok: false,
            msg: isVaultLockedError(err)
              ? controllerContext.t("sessionEditor2.errVaultLockedProxy")
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
      await controllerContext.addSession(config);
      controllerContext.setTestResult({ ok: true, msg: controllerContext.t("sessionEditor2.proxySessionSaved") });
    } catch (err) {
      controllerContext.setTestResult({ ok: false, msg: String(err) });
    }
  };
}

import { ensureVaultReady } from "../../../lib/vaultGate";
import { toNetworkSettingsPayload, type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import type { SessionConfig } from "../../../lib/ipc";
import { mailOAuthAuthorize, mailOAuthDeviceComplete, mailOAuthDeviceStart } from "../../../lib/mail";
import { type MailProvider, type MailAuthMode, type MailOAuthFlow, type MailOAuthDeviceInfo, effectiveMailOAuthFlow, mailOAuthClientSecretRequired, supportsMailOAuthProvider } from "./mailPolicy";



export interface HandleMailOAuthConnectContext {
  setMailOauthStatus: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  mailProvider: MailProvider;
  mailOauthFlow: MailOAuthFlow;
  username: string;
  mailOauthClientId: string;
  mailOauthClientSecret: string;
  mailOauthClientSecretRef: string;
  t: import("../../../lib/i18n").TranslateFn;
  setMailOauthConnecting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setMailOauthDeviceInfo: import("react").Dispatch<import("react").SetStateAction<MailOAuthDeviceInfo | null>>;
  session: SessionConfig | undefined;
  networkSettings: NetworkSettingsValue;
  setMailAuthMode: import("react").Dispatch<import("react").SetStateAction<MailAuthMode>>;
  setMailOauthTokenRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  setMailOauthExpiresAt: import("react").Dispatch<import("react").SetStateAction<string>>;
  setMailOauthScope: import("react").Dispatch<import("react").SetStateAction<string>>;
}


export function createHandleMailOAuthConnect(controllerContext: HandleMailOAuthConnectContext): () => Promise<void> {
  return async () => {
    controllerContext.setMailOauthStatus(null);
    if (!supportsMailOAuthProvider(controllerContext.mailProvider)) {
      controllerContext.setMailOauthStatus({ ok: false, msg: "Select Gmail or Outlook first." });
      return;
    }
    const oauthProvider = controllerContext.mailProvider;
    const oauthProviderLabel = oauthProvider === "gmail" ? "Gmail" : "Outlook";
    const selectedMailOauthFlow = effectiveMailOAuthFlow(oauthProvider, controllerContext.mailOauthFlow);
    if (!controllerContext.username.trim()) {
      controllerContext.setMailOauthStatus({ ok: false, msg: "Enter the mail email address first." });
      return;
    }
    if (!controllerContext.mailOauthClientId.trim()) {
      controllerContext.setMailOauthStatus({ ok: false, msg: "Enter the OAuth2 client ID first." });
      return;
    }
    const oauthClientSecretValue = controllerContext.mailOauthClientSecret || controllerContext.mailOauthClientSecretRef || null;
    if (mailOAuthClientSecretRequired(oauthProvider, selectedMailOauthFlow) && !oauthClientSecretValue) {
      controllerContext.setMailOauthStatus({ ok: false, msg: "Enter the OAuth2 client secret first." });
      return;
    }
    const ready = await ensureVaultReady(controllerContext.t("vault.gateReasonSession"));
    if (!ready) {
      controllerContext.setMailOauthStatus({ ok: false, msg: controllerContext.t("sessionEditor2.errVaultLockedSave") });
      return;
    }

    controllerContext.setMailOauthConnecting(true);
    controllerContext.setMailOauthDeviceInfo(null);
    try {
      const sessionId = controllerContext.session?.id ?? (controllerContext.username.trim() || "mail-editor");
      const networkPayload =
        controllerContext.networkSettings.proxyKind !== "none"
          ? toNetworkSettingsPayload(controllerContext.networkSettings)
          : null;
      const result = selectedMailOauthFlow === "device"
        ? await (async () => {
            const device = await mailOAuthDeviceStart({
              sessionId,
              provider: oauthProvider,
              emailAddress: controllerContext.username.trim(),
              clientId: controllerContext.mailOauthClientId.trim(),
              networkSettings: networkPayload,
            });
            controllerContext.setMailOauthDeviceInfo({
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              message: device.message,
              expiresIn: device.expiresIn,
            });
            controllerContext.setMailOauthStatus({
              ok: true,
              msg: `Enter code ${device.userCode} to approve ${oauthProviderLabel} access.`,
            });
            return mailOAuthDeviceComplete({
              sessionId,
              provider: oauthProvider,
              emailAddress: controllerContext.username.trim(),
              clientId: controllerContext.mailOauthClientId.trim(),
              clientSecret: oauthProvider === "gmail" ? oauthClientSecretValue : null,
              deviceCode: device.deviceCode,
              interval: device.interval,
              expiresIn: device.expiresIn,
              networkSettings: networkPayload,
            });
        })()
        : await mailOAuthAuthorize({
            sessionId,
            provider: oauthProvider,
            emailAddress: controllerContext.username.trim(),
            clientId: controllerContext.mailOauthClientId.trim(),
            clientSecret: oauthClientSecretValue,
            networkSettings: networkPayload,
          });
      controllerContext.setMailAuthMode("oauth2");
      controllerContext.setMailOauthTokenRef(result.tokenRef);
      controllerContext.setMailOauthExpiresAt(result.expiresAt ? String(result.expiresAt) : "");
      controllerContext.setMailOauthScope(result.scope ?? "");
      controllerContext.setMailOauthDeviceInfo(null);
      controllerContext.setMailOauthStatus({ ok: true, msg: "OAuth2 connected." });
    } catch (err) {
      controllerContext.setMailOauthStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      controllerContext.setMailOauthConnecting(false);
    }
  };
}

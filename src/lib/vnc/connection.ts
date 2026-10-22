import { invoke } from "@tauri-apps/api/core";
import { type VncClipboardPolicy, type VncConnectExtras, type VncConnectResult, type VncDetachClaim, type VncSecurityPolicy } from "./model";

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
  networkSettingsJson?: string | null,
  securityPolicy: VncSecurityPolicy = "prefer-encryption",
  viewOnly = false,
  clipboardPolicy: VncClipboardPolicy = "bidirectional",
  extras: VncConnectExtras = {},
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    securityPolicy,
    viewOnly,
    clipboardPolicy,
    pictureQuality: extras.pictureQuality ?? null,
    shared: extras.shared ?? null,
    allowUnencrypted: extras.allowUnencrypted ?? null,
    attemptId: extras.attemptId ?? null,
  });
}

/** Stop an in-flight `vncConnect` started with `attemptId`. */
export async function vncCancelConnect(attemptId: string): Promise<boolean> {
  return invoke<boolean>("vnc_cancel_connect", { attemptId });
}

export async function vncCreateDetachClaim(claim: VncDetachClaim): Promise<string> {
  const result = await invoke<{ claim_id: string; }>("vnc_create_detach_claim", { claim });
  return result.claim_id;
}

export async function vncConsumeDetachClaim(claimId: string): Promise<VncDetachClaim> {
  return invoke<VncDetachClaim>("vnc_consume_detach_claim", { claimId });
}

export function redactVncHandoff<
  T extends {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
    networkSettingsJson?: string | null;
    claimId?: string;
  },
>(params: T, claimId?: string): T {
  return {
    ...params,
    host: claimId ? "" : params.host,
    port: claimId ? 0 : params.port,
    username: claimId ? null : params.username,
    password: undefined,
    networkSettingsJson: null,
    claimId,
  };
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncTestConnection(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
  networkSettingsJson?: string | null,
  securityPolicy: VncSecurityPolicy = "prefer-encryption",
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    securityPolicy,
  });
}

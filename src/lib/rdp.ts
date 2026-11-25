import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./ipc";
import type { RdpOptions } from "../types/rdp";
import { serializeRdpOptions } from "../types/rdp";

export interface RdpConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
}

/** Begin an RDP session. Returns the loopback WS port the canvas connects to. */
export async function rdpConnect(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<RdpConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<RdpConnectResult>("rdp_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

/** Close a session previously opened with `rdpConnect`. */
export async function rdpDisconnect(sessionId: string): Promise<void> {
  return invoke("rdp_disconnect", { sessionId });
}

export async function rdpTrustCertificate(
  host: string,
  port: number,
  fingerprint: string,
): Promise<string> {
  return invoke<string>("rdp_trust_certificate", { host, port, fingerprint });
}

/** Run the X.224 + Negotiation handshake without spawning the relay. */
export async function rdpTestConnection(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("rdp_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./vault";

// --- VNC ────────────────────────────────────────────────────────────

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
  width: number;
  height: number;
  name: string;
}

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
  networkSettingsJson?: string | null,
  securityPolicy: "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" = "prefer-encryption",
  viewOnly = false,
  clipboardPolicy: "disabled" | "client-to-server" | "server-to-client" | "bidirectional" = "bidirectional",
): Promise<VncConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<VncConnectResult>("vnc_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      networkSettingsJson: networkSettingsJson ?? null,
      securityPolicy,
      viewOnly,
      clipboardPolicy,
    }),
  );
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
  securityPolicy: "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" = "prefer-encryption",
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke("vnc_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      networkSettingsJson: networkSettingsJson ?? null,
      securityPolicy,
    }),
  );
}

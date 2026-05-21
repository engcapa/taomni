import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { withVaultLockedNotice } from "./ipc";

export type TunnelKind = "Local" | "Remote" | "Dynamic";

export type TunnelStatus = "stopped" | "starting" | "running" | "error";

export type TunnelAuthMethod = "Password" | "PrivateKey" | "Agent";

export interface TunnelSshCreds {
  host: string;
  port: number;
  username: string;
  authMethod: TunnelAuthMethod;
  /** key path for PrivateKey, password for Password (only kept in memory unless saveAuth is true) */
  authData: string | null;
  /** If true, persist authData to disk (vault). Default false. */
  saveAuth?: boolean;
}

export interface TunnelConfig {
  id: string;
  name: string;
  kind: TunnelKind;
  /** Listen address on the local machine. Defaults to 127.0.0.1. */
  listenHost: string;
  /** Listen port (Forward port column for Local/Dynamic, ignored for Remote where it's the SSH server's port). */
  listenPort: number;
  /** Destination host (Local/Remote). For Dynamic SOCKS this is unused. */
  destHost: string;
  /** Destination port (Local/Remote). For Dynamic SOCKS this is unused. */
  destPort: number;
  /** Optional reference to a saved SSH session id. If set, ssh creds below may be ignored. */
  sshSessionId?: string | null;
  ssh: TunnelSshCreds;
  description?: string;
  autostart?: boolean;
  sortOrder?: number;
}

export interface TunnelStatusInfo {
  id: string;
  status: TunnelStatus;
  /** Human-readable error if status === 'error'. */
  error?: string;
  /** Number of currently active forwarded connections. */
  activeConnections?: number;
}

export async function listTunnels(): Promise<TunnelConfig[]> {
  return invoke<TunnelConfig[]>("list_tunnels", {});
}

export async function upsertTunnel(config: TunnelConfig): Promise<TunnelConfig> {
  return invoke<TunnelConfig>("upsert_tunnel", { config });
}

export async function deleteTunnel(id: string): Promise<void> {
  return invoke("delete_tunnel", { id });
}

export async function startTunnel(id: string): Promise<TunnelStatusInfo> {
  return withVaultLockedNotice(() => invoke<TunnelStatusInfo>("start_tunnel", { id }));
}

export async function stopTunnel(id: string): Promise<TunnelStatusInfo> {
  return invoke<TunnelStatusInfo>("stop_tunnel", { id });
}

export async function startAllTunnels(): Promise<TunnelStatusInfo[]> {
  return invoke<TunnelStatusInfo[]>("start_all_tunnels", {});
}

export async function stopAllTunnels(): Promise<TunnelStatusInfo[]> {
  return invoke<TunnelStatusInfo[]>("stop_all_tunnels", {});
}

export async function reorderTunnels(ids: string[]): Promise<void> {
  return invoke("reorder_tunnels", { ids });
}

export async function testTunnel(id: string): Promise<string> {
  return invoke<string>("test_tunnel", { id });
}

export async function getTunnelStatus(id: string): Promise<TunnelStatusInfo> {
  return invoke<TunnelStatusInfo>("get_tunnel_status", { id });
}

export async function listTunnelStatuses(): Promise<TunnelStatusInfo[]> {
  return invoke<TunnelStatusInfo[]>("list_tunnel_statuses", {});
}

export async function listenTunnelStatus(
  callback: (info: TunnelStatusInfo) => void,
): Promise<UnlistenFn> {
  return listen<TunnelStatusInfo>("tunnel-status", (event) => {
    callback(event.payload);
  });
}

export function newTunnelId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tnl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function defaultTunnel(kind: TunnelKind = "Local"): TunnelConfig {
  return {
    id: newTunnelId(),
    name: "",
    kind,
    listenHost: "127.0.0.1",
    listenPort: 0,
    destHost: "",
    destPort: 0,
    ssh: {
      host: "",
      port: 22,
      username: "",
      authMethod: "Password",
      authData: null,
      saveAuth: false,
    },
    description: "",
    autostart: false,
    sortOrder: 0,
  };
}

export function tunnelKindLabel(kind: TunnelKind): string {
  switch (kind) {
    case "Local":
      return "Local";
    case "Remote":
      return "Remote";
    case "Dynamic":
      return "Dynamic";
  }
}

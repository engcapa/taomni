import { emit } from "../tauri-event";

export const TUNNEL_STORAGE_KEY = "taomni.tunnels.v1";

export interface StubTunnelStatus {
  id: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
  activeConnections?: number;
}

export const tunnelStatuses: Record<string, StubTunnelStatus> = {};

export interface StubTunnelConfig {
  id: string;
  name: string;
  kind: "Local" | "Remote" | "Dynamic";
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  sshSessionId?: string | null;
  ssh: {
    host: string;
    port: number;
    username: string;
    authMethod: "Password" | "PrivateKey" | "Agent";
    authData: string | null;
    saveAuth?: boolean;
  };
  description?: string;
  autostart?: boolean;
  sortOrder?: number;
}

export function loadTunnels(): StubTunnelConfig[] {
  try {
    return JSON.parse(localStorage.getItem(TUNNEL_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveTunnels(list: StubTunnelConfig[]): void {
  // Strip secrets unless saveAuth is true (mirrors how the desktop vault behaves).
  const sanitized = list.map((t) => ({
    ...t,
    ssh: {
      ...t.ssh,
      authData: t.ssh.saveAuth ? t.ssh.authData : (t.ssh.authMethod === "PrivateKey" ? t.ssh.authData : null),
    },
  }));
  localStorage.setItem(TUNNEL_STORAGE_KEY, JSON.stringify(sanitized));
}

export async function invokeTunnel<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "list_tunnels": {
      return loadTunnels() as T;
    }

    case "upsert_tunnel": {
      const config = args?.config as StubTunnelConfig;
      const list = loadTunnels();
      const idx = list.findIndex((t) => t.id === config.id);
      if (idx >= 0) list[idx] = config;
      else list.push(config);
      saveTunnels(list);
      return config as T;
    }

    case "delete_tunnel": {
      const id = args?.id as string;
      saveTunnels(loadTunnels().filter((t) => t.id !== id));
      delete tunnelStatuses[id];
      return undefined as T;
    }

    case "start_tunnel": {
      const id = args?.id as string;
      const tunnel = loadTunnels().find((t) => t.id === id);
      if (!tunnel) throw new Error(`Tunnel ${id} not found`);
      tunnelStatuses[id] = {
        id,
        status: "error",
        error: "Tunnels can only be opened in the desktop build of Taomni.",
      };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }

    case "stop_tunnel": {
      const id = args?.id as string;
      tunnelStatuses[id] = { id, status: "stopped" };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }

    case "start_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = {
          id: t.id,
          status: "error",
          error: "Desktop-only feature in preview mode.",
        };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }

    case "stop_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = { id: t.id, status: "stopped" };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }

    case "get_tunnel_status": {
      const id = args?.id as string;
      return (tunnelStatuses[id] ?? { id, status: "stopped" }) as T;
    }

    case "list_tunnel_statuses": {
      return Object.values(tunnelStatuses) as T;
    }

    case "test_tunnel": {
      throw new Error("Testing tunnels is only available in the desktop build.");
    }

    case "reorder_tunnels": {
      const ids = (args?.ids as string[]) ?? [];
      const list = loadTunnels();
      const byId = new Map(list.map((t) => [t.id, t]));
      const next: StubTunnelConfig[] = [];
      ids.forEach((id, idx) => {
        const t = byId.get(id);
        if (!t) return;
        next.push({ ...t, sortOrder: idx });
        byId.delete(id);
      });
      for (const t of byId.values()) next.push(t);
      saveTunnels(next);
      return undefined as T;
    }
    default: throw new Error(`Unhandled tunnel stub command: ${cmd}`);
  }
}

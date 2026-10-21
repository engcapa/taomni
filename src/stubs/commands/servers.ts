

// ---------- Local servers browser-preview state ----------
export const STUB_SERVER_CONFIGS_KEY = "taomni.stub.serverConfigs.v1";

export const STUB_SERVER_TYPES = ["ssh", "ftp", "tftp", "http", "telnet", "vnc", "nfs", "cron", "iperf", "rdp"];

export function readStubServerConfigs(): Record<string, Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(STUB_SERVER_CONFIGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Windows built-in Remote Desktop state for browser preview. QA cases pick a
 * scenario with the `stubSystemRdp` query parameter (use-system,
 * enable-system, needs-admin, home, unknown); without it the check is not
 * applicable, matching macOS/Linux.
 */
export function stubSystemRdpStatus(): Record<string, unknown> {
  const scenario = new URLSearchParams(window.location.search).get("stubSystemRdp");
  const base = {
    applicable: true,
    supported: true,
    edition: "Professional",
    port: 3389,
    nla: true,
    isServer: false,
    errors: [] as string[],
  };
  switch (scenario) {
    case "use-system":
      return { ...base, enabled: true, serviceRunning: true, portInUse: true, isAdmin: false, recommendation: "use-system" };
    case "enable-system":
      return { ...base, enabled: false, serviceRunning: false, portInUse: false, isAdmin: true, recommendation: "enable-system" };
    case "needs-admin":
      return { ...base, enabled: false, serviceRunning: false, portInUse: false, isAdmin: false, recommendation: "needs-admin" };
    case "home":
      return { ...base, supported: false, edition: "Core", enabled: false, serviceRunning: false, isAdmin: true, recommendation: "taomni" };
    case "unknown":
      return { ...base, enabled: null, serviceRunning: null, isAdmin: null, recommendation: "unknown", errors: ["stub: registry unavailable"] };
    default:
      return { applicable: false, recommendation: "taomni" };
  }
}

export async function invokeServers<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- Local servers (browser preview: settings only) ----------
    // Configs persist in localStorage so Apply/reload flows are testable; a
    // server can never actually start in the browser, so start fails loudly.
    case "load_server_configs": {
      return readStubServerConfigs() as T;
    }

    case "save_server_config": {
      const { serverType, config } = (args ?? {}) as {
        serverType: string;
        config: Record<string, unknown>;
      };
      const saved = { ...config };
      if (serverType === "rdp" && typeof saved.password === "string" && saved.password) {
        delete saved.password;
        saved.passwordRef = "vault:stub-rdp-server-password";
      }
      const configs = readStubServerConfigs();
      configs[serverType] = saved;
      localStorage.setItem(STUB_SERVER_CONFIGS_KEY, JSON.stringify(configs));
      return saved as T;
    }

    case "list_server_statuses": {
      return STUB_SERVER_TYPES.map((serverType) => ({ serverType, status: "stopped" })) as T;
    }

    // No server runs in the browser, so there is no backend log history.
    case "list_server_logs": {
      return {} as T;
    }

    case "clear_server_log": {
      return undefined as T;
    }

    case "get_server_status":

    case "stop_local_server": {
      const { serverType } = (args ?? {}) as { serverType: string };
      return { serverType, status: "stopped" } as T;
    }

    case "start_local_server": {
      throw new Error(
        "Local servers run only in the desktop build of Taomni, not in browser preview.",
      );
    }
    default: throw new Error(`Unhandled servers stub command: ${cmd}`);
  }
}

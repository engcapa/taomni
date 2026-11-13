

// ---------- Local servers browser-preview state ----------
export const STUB_SERVER_CONFIGS_KEY = "taomni.stub.serverConfigs.v1";
export const STUB_SERVERS_TAB_LOCK_KEY = "taomni.stub.serversTabLock.v1";

const SERVERS_TAB_LOCK_TTL_MS = 15_000;
const SERVERS_TAB_LOCK_HEARTBEAT_MS = 4_000;

const stubTabOwnerId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `stub-servers-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let stubLockHeartbeatTimer: number | null = null;
let stubLockUnloadBound = false;

interface StubServersTabLockRecord {
  ownerId: string;
  updatedAt: number;
}

function readStubServersTabLock(): StubServersTabLockRecord | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STUB_SERVERS_TAB_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StubServersTabLockRecord>;
    if (typeof parsed.ownerId !== "string" || typeof parsed.updatedAt !== "number") {
      return null;
    }
    if (Date.now() - parsed.updatedAt >= SERVERS_TAB_LOCK_TTL_MS) {
      return null;
    }
    return { ownerId: parsed.ownerId, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function stopStubServersTabHeartbeat() {
  if (stubLockHeartbeatTimer !== null && typeof window !== "undefined") {
    window.clearInterval(stubLockHeartbeatTimer);
  }
  stubLockHeartbeatTimer = null;
}

function writeStubServersTabLock() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    STUB_SERVERS_TAB_LOCK_KEY,
    JSON.stringify({ ownerId: stubTabOwnerId, updatedAt: Date.now() }),
  );
}

function releaseOwnedStubServersTabLock() {
  stopStubServersTabHeartbeat();
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STUB_SERVERS_TAB_LOCK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<StubServersTabLockRecord>;
    if (parsed.ownerId === stubTabOwnerId) {
      localStorage.removeItem(STUB_SERVERS_TAB_LOCK_KEY);
    }
  } catch {
    /* ignore corrupt lock payload on cleanup */
  }
}

function ensureStubLockListeners() {
  if (typeof window === "undefined") return;
  if (!stubLockUnloadBound) {
    stubLockUnloadBound = true;
    const releaseOnExit = () => {
      releaseOwnedStubServersTabLock();
    };
    window.addEventListener("pagehide", releaseOnExit);
    window.addEventListener("beforeunload", releaseOnExit);
  }
  if (stubLockHeartbeatTimer === null) {
    stubLockHeartbeatTimer = window.setInterval(() => {
      const active = readStubServersTabLock();
      if (active && active.ownerId === stubTabOwnerId) {
        writeStubServersTabLock();
      } else {
        stopStubServersTabHeartbeat();
      }
    }, SERVERS_TAB_LOCK_HEARTBEAT_MS);
  }
}

/** Test-only helper to reset the in-realm browser stub lock timer cleanly. */
export function resetStubServersTabLockForTests(): void {
  releaseOwnedStubServersTabLock();
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(STUB_SERVERS_TAB_LOCK_KEY);
  }
}

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

    case "claim_servers_tab": {
      const current = readStubServersTabLock();
      if (current && current.ownerId !== stubTabOwnerId) {
        return { acquired: false, holder: "another Taomni browser window" } as T;
      }
      writeStubServersTabLock();
      ensureStubLockListeners();
      return { acquired: true, holder: null } as T;
    }

    case "release_servers_tab": {
      releaseOwnedStubServersTabLock();
      return undefined as T;
    }

    default: throw new Error(`Unhandled servers stub command: ${cmd}`);
  }
}

import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./vault";

export async function testProxyConnection(
  proxyKind: string,
  proxyHost: string,
  proxyPort: number,
  proxyUser: string,
  proxyPass: string,
  testHost: string,
  testPort: number,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("test_proxy_connection", {
      proxyKind,
      proxyHost,
      proxyPort,
      proxyUser,
      proxyPass,
      testHost,
      testPort,
    }),
  );
}

/**
 * Application-level outbound proxy (settings → "Application Proxy"). Distinct
 * from the per-session proxy in NetworkSettings. Field names mirror the Rust
 * `AppProxyConfig` (snake_case) so the object crosses the IPC boundary as-is.
 */
export interface AppProxyConfig {
  enabled: boolean;
  /** "session" | "manual" */
  mode: string;
  /** Saved Proxy session id (mode === "session"). */
  session_id: string;
  /** "http" | "socks5" (mode === "manual"). */
  kind: string;
  host: string;
  port: number;
  username: string;
  /** vault:<id> reference to the manual password; never plaintext. */
  password_ref: string;
}

export async function getAppProxyConfig(): Promise<AppProxyConfig> {
  return invoke<AppProxyConfig>("get_app_proxy_config");
}

export async function saveAppProxyConfig(config: AppProxyConfig): Promise<void> {
  return invoke("save_app_proxy_config", { config });
}

/** Resolved proxy URL for the updater; null for a direct connection. */
export async function getAppProxyUrl(): Promise<string | null> {
  return invoke<string | null>("get_app_proxy_url");
}

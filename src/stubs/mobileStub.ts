// Browser preview only: no native listener is created by these settings stubs.
import { feishuStub } from "./feishuStub";
import type { MobileListenerConfig } from "../lib/mobileListener";

const listenerKey = "taomni-preview-mobile-listener";
function listenerConfig(): MobileListenerConfig {
  const raw = localStorage.getItem(listenerKey);
  return raw ? JSON.parse(raw) as MobileListenerConfig : { allowed_hosts: [], allow_all_hosts: false };
}
interface Status { enabled: boolean; address: string | null; failed_attempts: number; devices: unknown[]; allow_open_sessions: boolean }
let status: Status = { enabled: false, address: null, failed_attempts: 0, devices: [], allow_open_sessions: false };
export async function mobileStub(command: string, args?: Record<string, unknown>) {
  if (command.startsWith("mobile_feishu_")) return feishuStub(command, args);
  if (command === "mobile_listener_get") return listenerConfig();
  if (command === "mobile_listener_save") {
    const config = args?.config as MobileListenerConfig;
    if (!config || !Array.isArray(config.allowed_hosts) || typeof config.allow_all_hosts !== "boolean") throw new Error("invalid_mobile_listener_config");
    if (config.allowed_hosts.length > 32) throw new Error("too_many_mobile_hosts");
    const hosts = config.allowed_hosts.map(host => host.trim().toLowerCase());
    if (hosts.some(host => {
      if (!host || host.length > 255 || /[\s/@?#*\\]/.test(host) || host.endsWith(":")) return true;
      try {
        const url = new URL(`http://${host}`);
        return !url.hostname || url.pathname !== "/";
      } catch { return true; }
    })) throw new Error("invalid_mobile_host");
    const next = { allowed_hosts: [...new Set(hosts)], allow_all_hosts: config.allow_all_hosts };
    localStorage.setItem(listenerKey, JSON.stringify(next));
    return next;
  }
  if (command === "mobile_start") status = { ...status, enabled: true, address: `http://127.0.0.1:${args?.port || 8787}` };
  if (command === "mobile_stop") status = { ...status, enabled: false, address: null };
  if (command === "mobile_pairing_code") return "preview-only-pairing-code";
  if (command === "mobile_revoke") return;
  if (command === "mobile_set_open_sessions") { status = { ...status, allow_open_sessions: !!args?.enabled }; return status.allow_open_sessions; }
  if (command === "mobile_claim_open_session") return status.enabled && status.allow_open_sessions;
  if (command === "mobile_terminal_title" || command === "mobile_open_session_result") return true;
  return structuredClone(status);
}

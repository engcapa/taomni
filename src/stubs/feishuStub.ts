// Renderer preview only. No Feishu connection or message is made here.
import { loadStubVault } from "./commands/vault";
let config = { allow_file_content: false, app_id: "", secret_ref: "", mobile_endpoint: "", bindings: [] as { open_id: string; chat_id: string }[], proxy_mode: "app", custom_proxy: { enabled: true, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" } };
let status = { state: "stopped", error: null as string | null, reconnects: 0, delivered: 0, failed_deliveries: 0, rejected: 0, duplicates: 0 };
export function feishuStub(command: string, args?: Record<string, unknown>) {
  if (command === "mobile_feishu_save") {
    const next = args?.config as typeof config;
    if (next.bindings.some(b => !b.open_id.startsWith("ou_") || !b.chat_id.startsWith("oc_"))) throw new Error("invalid_identity_binding");
    if (args?.secret && loadStubVault().state !== "unlocked") throw new Error("VAULT_LOCKED");
    config = { ...next, secret_ref: args?.secret ? "vault:preview-feishu" : config.secret_ref };
  }
  if (command === "mobile_feishu_start") status = { ...status, state: "connecting", error: "browser_preview_no_real_connection" };
  if (command === "mobile_feishu_stop") status = { ...status, state: "stopped", error: null };
  if (command === "mobile_feishu_start" || command === "mobile_feishu_stop") return structuredClone(status);
  return structuredClone({ config, status, secret_configured: !!config.secret_ref });
}

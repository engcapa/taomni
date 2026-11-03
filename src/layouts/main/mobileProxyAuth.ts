import { getAppProxyConfig, getSession, type AppProxyConfig } from "../../lib/ipc";
import type { NetworkSettings } from "../../lib/networkSettings";
import { passwordRefFromOptions } from "./authentication";

export interface MobileAuthPrompt { prompt: string; echo: boolean; initial: string }
export type MobileAsk = (name: string, instructions: string, prompts: MobileAuthPrompt[]) => Promise<string[]>;

/** Materialize proxy selection for one attempt. Never changes app/session settings. */
export async function prepareMobileProxy(network: NetworkSettings, locked: boolean, ask: MobileAsk): Promise<NetworkSettings> {
  let proxy = { ...network };
  let config: AppProxyConfig | undefined;
  if (proxy.proxyKind === "app") config = await getAppProxyConfig();
  else if (proxy.proxyKind === "custom") {
    config = proxy.customProxy;
    if (!config) throw new Error("proxy_config_missing");
  }
  if (config) {
    if (!config.enabled) return { ...proxy, proxyKind: "none", proxySessionId: "", proxyPass: "" };
    if (config.mode === "session") {
      if (!config.session_id.trim()) throw new Error("proxy_session_missing");
      proxy.proxySessionId = config.session_id;
      proxy.proxyKind = "http"; // Actual protocol is read from the saved row below.
    } else if (config.mode === "manual") {
      if (config.kind !== "http" && config.kind !== "socks5") throw new Error("invalid_proxy_kind");
      proxy = { ...proxy, proxyKind: config.kind, proxyHost: config.host, proxyPort: String(config.port), proxyUser: config.username, proxyPass: config.password_ref, proxySessionId: "" };
    } else throw new Error("invalid_proxy_mode");
  }
  if (!["http", "socks5"].includes(proxy.proxyKind)) return proxy;
  if (proxy.proxySessionId) {
    const saved = await getSession(proxy.proxySessionId);
    if (saved.session_type !== "Proxy") throw new Error("invalid_proxy_session");
    const kind = JSON.parse(saved.options_json || "{}").proxyKind || "http";
    if (kind !== "http" && kind !== "socks5") throw new Error("invalid_proxy_kind");
    proxy = { ...proxy, proxyKind: kind, proxyHost: saved.host, proxyPort: String(saved.port), proxyUser: saved.username || "", proxyPass: passwordRefFromOptions(saved) || "", proxySessionId: "" };
  }
  if (locked && proxy.proxyPass.startsWith("vault:")) {
    const answer = await ask(`代理 ${proxy.proxyHost}:${proxy.proxyPort}`, "保险库已锁定。输入本次代理凭据，不修改代理设置或已保存会话。", [
      { prompt: "代理用户名", echo: true, initial: proxy.proxyUser },
      { prompt: "代理密码", echo: false, initial: "" },
    ]);
    proxy = { ...proxy, proxyUser: answer[0], proxyPass: answer[1], proxySaveAuth: false };
  }
  return proxy;
}

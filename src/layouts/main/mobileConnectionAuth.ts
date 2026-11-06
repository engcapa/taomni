import { invoke } from "@tauri-apps/api/core";
import { getSession, type SessionConfig } from "../../lib/ipc";
import { getSessionNetworkSettings } from "../../lib/networkSettings";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { useVaultStore } from "../../stores/vaultStore";
import { passwordRefFromOptions, resolveSessionAuth } from "./authentication";

import { prepareMobileProxy, type MobileAsk, type MobileAuthPrompt } from "./mobileProxyAuth";

/** One connection's credentials; never updates a saved session or the vault. */
export async function prepareMobileSsh(session: SessionConfig, requestId: string, signal: AbortSignal) {
  const ask: MobileAsk = async (name, instructions, prompts) => {
    const answer = await invoke<string[]>("mobile_connection_auth", { requestId, name, instructions, prompts });
    if (signal.aborted) throw new Error("open_cancelled");
    if (!Array.isArray(answer) || answer.length !== prompts.length) throw new Error("invalid_auth_response");
    return answer;
  };
  const vaultLocked = () => !["unlocked", "empty"].includes(useVaultStore.getState().state);
  let effective = { ...session };
  const { method, data } = resolveSessionAuth(session);
  let credential = method === "Password" ? passwordRefFromOptions(session) : data;
  const needsPassword = method === "Password" && (!credential || vaultLocked());
  if (needsPassword || !session.username?.trim()) {
    const prompts: MobileAuthPrompt[] = [{ prompt: "用户名", echo: true, initial: session.username || "root" }];
    if (needsPassword) prompts.push({ prompt: "密码", echo: false, initial: "" });
    const values = await ask(`连接 ${session.host}:${session.port}`, "仅用于本次连接，不修改已保存账户。保险库锁定时可直接输入本次密码，无需向手机提供保险库主密码。", prompts);
    if (!values[0].trim()) throw new Error("invalid_auth_response");
    effective.username = values[0].trim();
    if (needsPassword) credential = values[1];
  }

  // Materialize the same saved/manual jump settings for this attempt only.
  // Clearing the saved jump id prevents its vault ref overwriting a one-shot
  // phone answer in the backend's normal jump credential resolver.
  const network = await prepareMobileProxy(getSessionNetworkSettings(effective.options_json), vaultLocked(), ask);
  effective = { ...effective, options_json: JSON.stringify({ ...parseSessionOptions(effective.options_json), networkSettings: network }) };
  if (network.proxyKind === "ssh-tunnel") {
    let jump = { ...network };
    if (network.jumpSessionId) {
      const saved = await getSession(network.jumpSessionId);
      const auth = resolveSessionAuth(saved);
      jump = { ...jump, jumpHost: saved.host, jumpPort: String(saved.port), jumpUser: saved.username || "root", jumpAuthKind: auth.method === "PrivateKey" ? "PrivateKey" : "Password", jumpKeyPath: auth.data || "", jumpPassword: passwordRefFromOptions(saved) || network.jumpPassword };
    }
    if (jump.jumpAuthKind === "Password" && (!jump.jumpPassword || (jump.jumpPassword.startsWith("vault:") && vaultLocked()))) {
      const values = await ask(`跳板机 ${jump.jumpHost}:${jump.jumpPort}`, "先完成跳板机认证，再连接目标主机；仅本次使用。", [
        { prompt: "跳板机用户名", echo: true, initial: jump.jumpUser || "root" },
        { prompt: "跳板机密码", echo: false, initial: "" },
      ]);
      if (!values[0].trim()) throw new Error("invalid_auth_response");
      jump = { ...jump, jumpSessionId: "", jumpUser: values[0].trim(), jumpPassword: values[1], jumpSaveAuth: false };
      effective = { ...effective, options_json: JSON.stringify({ ...parseSessionOptions(effective.options_json), networkSettings: jump }) };
    }
  }
  if (signal.aborted) throw new Error("open_cancelled");
  return { session: effective, method, credential };
}

import { type SessionConfig } from "../../lib/ipc";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { getSessionNetworkSettings } from "../../lib/networkSettings";

export const SAVED_PASSWORD_VAULT_REASON_KEY = "vault.unlockReasonDefault";


export function resolveSessionAuth(session: SessionConfig): { method: string; data: string | null } {
  const method = typeof session.auth_method === "string"
    ? session.auth_method
    : "PrivateKey";
  const data = typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
    ? session.auth_method.PrivateKey.key_path
    : null;
  return { method, data };
}


export function passwordRefFromOptions(session: SessionConfig): string | null {
  const opts = parseSessionOptions(session.options_json);
  const ref = typeof opts.passwordRef === "string" ? opts.passwordRef : "";
  return ref && ref.startsWith("vault:") ? ref : null;
}


export interface MissingJumpPassword {
  session: SessionConfig;
  jumpSession?: SessionConfig;
  host: string;
  port: number;
  username: string;
  manual: boolean;
}


export function missingJumpPasswordForSession(
  session: SessionConfig,
  allSessions: SessionConfig[],
): MissingJumpPassword | null {
  const ns = getSessionNetworkSettings(session.options_json);
  if (ns.proxyKind !== "ssh-tunnel") return null;
  if (ns.jumpPassword.trim()) return null;

  const jumpSessionId = ns.jumpSessionId.trim();
  if (jumpSessionId) {
    const jumpSession = allSessions.find((s) => s.id === jumpSessionId);
    if (!jumpSession) return null;
    const { method } = resolveSessionAuth(jumpSession);
    if (method !== "Password") return null;
    if (passwordRefFromOptions(jumpSession)) return null;
    return {
      session,
      jumpSession,
      host: jumpSession.host,
      port: jumpSession.port,
      username: jumpSession.username ?? "root",
      manual: false,
    };
  }

  if (ns.jumpAuthKind !== "Password") return null;
  if (!ns.jumpHost.trim()) return null;
  return {
    session,
    host: ns.jumpHost.trim(),
    port: parseInt(ns.jumpPort, 10) || 22,
    username: ns.jumpUser.trim() || "root",
    manual: true,
  };
}


export function sessionWithJumpPassword(
  session: SessionConfig,
  password: string,
  saveAuth = false,
): SessionConfig {
  const opts = parseSessionOptions(session.options_json);
  const ns = getSessionNetworkSettings(session.options_json);
  const updated = {
    ...opts,
    networkSettings: {
      ...ns,
      jumpPassword: password,
      jumpSaveAuth: saveAuth || ns.jumpSaveAuth,
    },
  };
  return { ...session, options_json: JSON.stringify(updated) };
}

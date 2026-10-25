import { useEffect, useRef, useState } from "react";
import { AuthPrompt } from "../session/AuthPrompt";
import { useT } from "../../lib/i18n";
import { vaultPut, type SessionConfig } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import {
  missingJumpPasswordForSession,
  passwordRefFromOptions,
  resolveSessionAuth,
  sessionWithJumpPassword,
} from "../../layouts/main/authentication";

/** Connection credentials stay in this mounted runtime; persistence stores session ids only. */
export function useWorkspaceSessionAccess(saved: SessionConfig, visible: boolean) {
  const t = useT();
  const sessions = useSessionStore((state) => state.sessions);
  const vaultState = useVaultStore((state) => state.state);
  const [credential, setCredential] = useState<string>();
  const [jumpCredential, setJumpCredential] = useState<string>();
  const [promptOpen, setPromptOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const auth = resolveSessionAuth(saved);
  const password = credential ?? passwordRefFromOptions(saved) ?? undefined;
  const session = jumpCredential ? sessionWithJumpPassword(saved, jumpCredential) : saved;
  const jump = missingJumpPasswordForSession(session, sessions);
  const needsPassword = ["SSH", "SFTP", "RDP"].includes(saved.session_type) && auth.method === "Password" && !password;
  const needsUnlock = (password?.startsWith("vault:") || session.options_json?.includes("vault:"))
    && vaultState !== "unlocked";

  const submit = async (typed: string, remember: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      let resolved = typed;
      if (remember && await ensureVaultReady(t("vault.unlockReasonDefault"))) {
        if (!alive.current) return;
        const kind = jump || saved.session_type === "SSH" || saved.session_type === "SFTP" ? "ssh-password" : "rdp-password";
        const label = jump ? `${jump.username}@${jump.host}:${jump.port}` : `${saved.username ?? "user"}@${saved.host}:${saved.port}`;
        const result = await vaultPut(kind, label, typed);
        resolved = result.reference;
        if (!alive.current) return;
        if (jump?.jumpSession) {
          const target = useSessionStore.getState().sessions.find((entry) => entry.id === jump.jumpSession!.id) ?? jump.jumpSession;
          await useSessionStore.getState().updateSession({ ...target, options_json: JSON.stringify({ ...parseSessionOptions(target.options_json), passwordRef: resolved }) });
        } else if (jump) {
          await useSessionStore.getState().updateSession(sessionWithJumpPassword(saved, resolved, true));
        } else {
          await useSessionStore.getState().updateSession({ ...saved, options_json: JSON.stringify({ ...parseSessionOptions(saved.options_json), passwordRef: resolved }) });
        }
      }
      if (!alive.current) return;
      if (jump) setJumpCredential(resolved);
      else setCredential(resolved);
      setPromptOpen(true);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const blocked = needsUnlock || needsPassword || !!jump;
  const gate = blocked ? (
    <div data-testid="workspace-session-access" className="flex h-full flex-col items-center justify-center gap-3 p-4"
      style={{ display: visible ? "flex" : "none" }}>
      <span>{t("authPrompt.titleRequired")}</span>
      {error && <span role="alert">{error}</span>}
      <button type="button" data-testid="workspace-session-connect" className="taomni-btn" disabled={busy}
        onClick={() => needsUnlock ? void ensureVaultReady(t("vault.unlockReasonDefault")) : setPromptOpen(true)}>
        {needsUnlock ? t("platform.unlockSessions") : t("authPrompt.submit")}
      </button>
      {visible && !needsUnlock && promptOpen && (
        <AuthPrompt key={jump ? "jump" : "session"} host={jump?.host ?? saved.host} username={jump?.username ?? saved.username ?? "root"}
          onCancel={() => setPromptOpen(false)} onSubmit={(typed, remember) => void submit(typed, remember)} />
      )}
    </div>
  ) : null;

  return { session, password, auth: { ...auth, data: auth.method === "Password" ? password ?? null : auth.data }, gate };
}

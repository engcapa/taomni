import { objectStorageHasVaultSecret } from "../../lib/objectStorage";
import type { Tab } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { vaultPut } from "../../lib/ipc";
import { useVaultStore } from "../../stores/vaultStore";
import { ensureVaultReady } from "../../lib/vaultGate";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { getSessionTerminalProfile, type TerminalProfile } from "../../lib/terminalProfile";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { t as tr } from "../../lib/i18n";
import { type PendingAuth, type ConnectQueueEntry, type ResumeQueueContext, type ConnectQueueOutcome } from "./types";
import { localShellSelectionFromSession, COMMAND_TERMINAL_SESSION_TYPES } from "./sessionPolicy";
import { SAVED_PASSWORD_VAULT_REASON_KEY, passwordRefFromOptions, missingJumpPasswordForSession, resolveSessionAuth, sessionWithJumpPassword } from "./authentication";
import { mailSmtpPasswordRefFromOptions } from "./mailSession";



export interface QueueVaultUnlockContext {
  connectQueueRef: import("react").RefObject<ConnectQueueEntry[]>;
  awaitingVaultUnlockRef: import("react").RefObject<boolean>;
  pendingVaultActionRef: import("react").RefObject<(() => void) | null>;
  continueConnectQueueRef: import("react").RefObject<() => void>;
  setVaultUnlockReason: import("react").Dispatch<import("react").SetStateAction<string | null>>;
}


export function createQueueVaultUnlock(controllerContext: QueueVaultUnlockContext): (session: SessionConfig, resume?: ResumeQueueContext) => ConnectQueueOutcome {
  return (
    session: SessionConfig,
    resume?: ResumeQueueContext,
  ): ConnectQueueOutcome => {
    controllerContext.connectQueueRef.current.unshift({ session, resume });
    controllerContext.awaitingVaultUnlockRef.current = true;
    controllerContext.pendingVaultActionRef.current = () => {
      controllerContext.awaitingVaultUnlockRef.current = false;
      controllerContext.continueConnectQueueRef.current();
    };
    controllerContext.setVaultUnlockReason((current) => current ?? tr(SAVED_PASSWORD_VAULT_REASON_KEY));
    return "awaiting-vault";
  };
}



export interface OpenAfterJumpPasswordContext {
  sessions: SessionConfig[];
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
}


export function createOpenAfterJumpPassword(controllerContext: OpenAfterJumpPasswordContext): (session: SessionConfig, open: (session: SessionConfig) => void) => ConnectQueueOutcome {
  return (
    session: SessionConfig,
    open: (session: SessionConfig) => void,
  ): ConnectQueueOutcome => {
    const missing = missingJumpPasswordForSession(session, controllerContext.sessions);
    if (missing) {
      controllerContext.awaitingManualAuthRef.current = true;
      controllerContext.setPendingAuth({
        kind: "jump",
        ...missing,
        onResolved: open,
      });
      return "awaiting-auth";
    }
    open(session);
    return "opened";
  };
}



export interface OpenQueuedSessionContext {
  queueVaultUnlock: (session: SessionConfig, resume?: ResumeQueueContext) => ConnectQueueOutcome;
  openAfterJumpPassword: (session: SessionConfig, open: (session: SessionConfig) => void) => ConnectQueueOutcome;
  openSshTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
  openSftpTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  openVncTab: (session: SessionConfig, password?: string) => void;
  openRdpTab: (session: SessionConfig, password?: string) => void;
  openFileSession: (session: SessionConfig) => void;
  openBrowserSession: (session: SessionConfig) => void;
  openCommandTerminalTab: (session: SessionConfig) => void;
  openDbTab: (session: SessionConfig, password?: string) => void;
  openHBaseShellTab: (session: SessionConfig, password?: string) => void;
  openProxyTestTab: (session: SessionConfig) => void;
  openObjectStorageTab: (session: SessionConfig) => void;
  tabsRef: import("react").RefObject<Tab[]>;
  setActiveTab: (id: string) => void;
  openMailTab: (session: SessionConfig, password?: string, smtpPassword?: string) => void;
  openUnsupportedTab: (session: SessionConfig) => void;
  markConnected: (id: string) => Promise<void>;
}


export function createOpenQueuedSession(controllerContext: OpenQueuedSessionContext): (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: ResumeQueueContext) => ConnectQueueOutcome {
  return (
    session: SessionConfig,
    localShellOverride?: LocalShellSelection,
    resume?: ResumeQueueContext,
  ): ConnectQueueOutcome => {
    if (session.session_type === "SSH") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
          return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSshTab(effectiveSession, "Password", ref));
        } else {
          controllerContext.awaitingManualAuthRef.current = true;
          controllerContext.setPendingAuth({
            kind: "session",
            session,
            resumeRequestId: resume?.requestId,
            restoreOperationId: resume?.operationId,
          });
          return "awaiting-auth";
        }
      } else {
        return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSshTab(effectiveSession, method, data));
      }
    } else if (session.session_type === "SFTP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
          return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSftpTab(effectiveSession, "Password", ref));
        } else {
          controllerContext.awaitingManualAuthRef.current = true;
          controllerContext.setPendingAuth({
            kind: "session",
            session,
            resumeRequestId: resume?.requestId,
            restoreOperationId: resume?.operationId,
          });
          return "awaiting-auth";
        }
      } else {
        return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSftpTab(effectiveSession, method, data));
      }
    } else if (session.session_type === "LocalShell") {
      controllerContext.openLocalTab(
        session.name || tr("tabs.localTerminal"),
        session.id,
        getSessionTerminalProfile(session.options_json),
        localShellOverride ?? localShellSelectionFromSession(session),
      );
    } else if (session.session_type === "VNC") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
          controllerContext.openVncTab(session, ref);
        } else {
          // DEC-VNC-21: connect first; the session's own authentication form
          // asks only when the server requires a password (RealVNC), so a
          // None-only server needs no input at all.
          controllerContext.openVncTab(session);
        }
      } else {
        controllerContext.openVncTab(session, data ?? undefined);
      }
    } else if (session.session_type === "RDP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
          return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openRdpTab(effectiveSession, ref));
        } else {
          controllerContext.awaitingManualAuthRef.current = true;
          controllerContext.setPendingAuth({
            kind: "session",
            session,
            resumeRequestId: resume?.requestId,
            restoreOperationId: resume?.operationId,
          });
          return "awaiting-auth";
        }
      } else {
        return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openRdpTab(effectiveSession, data ?? undefined));
      }
    } else if (session.session_type === "File") {
      controllerContext.openFileSession(session);
    } else if (session.session_type === "Browser") {
      controllerContext.openBrowserSession(session);
    } else if (COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) {
      controllerContext.openCommandTerminalTab(session);
    } else if (
      session.session_type === "MySQL" ||
      session.session_type === "PostgreSQL" ||
      session.session_type === "PanWeiDB" ||
      session.session_type === "Oracle" ||
      session.session_type === "SQLServer" ||
      session.session_type === "StarRocks" ||
      session.session_type === "ClickHouse" ||
      session.session_type === "Presto" ||
      session.session_type === "Redis"
    ) {
      // DB sessions store the password as a vault: ref in options_json. Many
      // databases (notably Redis / trust-auth Postgres) connect without one,
      // so a missing ref just means "no password" — we don't force a prompt.
      const ref = passwordRefFromOptions(session);
      if (ref) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
        return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openDbTab(effectiveSession, ref));
      } else {
        return controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openDbTab(effectiveSession, undefined));
      }
    } else if (session.session_type === "HBaseShell") {
      const ref = passwordRefFromOptions(session);
      if (ref) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
        controllerContext.openHBaseShellTab(session, ref);
      } else {
        controllerContext.openHBaseShellTab(session, undefined);
      }
    } else if (session.session_type === "Proxy") {
      controllerContext.openProxyTestTab(session);
    } else if (session.session_type === "S3" || session.session_type === "AzureBlob") {
      // Secrets are vault: refs in options_json; resolve happens server-side on
      // attach. If any secret is vault-backed and the vault is locked, unlock
      // first so the attach doesn't fail with a cryptic error.
      if (objectStorageHasVaultSecret(session)) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
      }
      return controllerContext.openAfterJumpPassword(session, controllerContext.openObjectStorageTab);
    } else if (session.session_type === "Mail") {
      const existing = controllerContext.tabsRef.current.find((tab) => tab.type === "mail" && tab.sessionId === session.id);
      if (existing) {
        controllerContext.setActiveTab(existing.id);
        return "opened";
      }
      const ref = passwordRefFromOptions(session);
      const smtpRef = mailSmtpPasswordRefFromOptions(session);
      if (ref || smtpRef) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return controllerContext.queueVaultUnlock(session, resume);
      }
      controllerContext.openMailTab(session, ref ?? undefined, smtpRef ?? undefined);
    } else {
      controllerContext.openUnsupportedTab(session);
      void controllerContext.markConnected(session.id);
    }
    return "opened";
  };
}



export interface ContinueConnectQueueContext {
  connectQueueRunningRef: import("react").RefObject<boolean>;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  awaitingVaultUnlockRef: import("react").RefObject<boolean>;
  connectQueueRef: import("react").RefObject<ConnectQueueEntry[]>;
  openQueuedSession: (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: ResumeQueueContext) => ConnectQueueOutcome;
}


export function createContinueConnectQueue(controllerContext: ContinueConnectQueueContext): () => void {
  return () => {
    if (controllerContext.connectQueueRunningRef.current || controllerContext.awaitingManualAuthRef.current || controllerContext.awaitingVaultUnlockRef.current) return;
    controllerContext.connectQueueRunningRef.current = true;
    try {
      while (controllerContext.connectQueueRef.current.length > 0) {
        const entry = controllerContext.connectQueueRef.current.shift();
        if (!entry) continue;
        const outcome = controllerContext.openQueuedSession(entry.session, undefined, entry.resume);
        if (outcome !== "opened") return;
      }
    } finally {
      controllerContext.connectQueueRunningRef.current = false;
    }
  };
}



export interface HandleAuthSubmitContext {
  pendingAuth: PendingAuth | null;
  updateSession: (config: SessionConfig) => Promise<void>;
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  continueConnectQueueRef: import("react").RefObject<() => void>;
  openAfterJumpPassword: (session: SessionConfig, open: (session: SessionConfig) => void) => ConnectQueueOutcome;
  openSftpTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
  openVncTab: (session: SessionConfig, password?: string) => void;
  openRdpTab: (session: SessionConfig, password?: string) => void;
  openSshTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
}


export function createHandleAuthSubmit(controllerContext: HandleAuthSubmitContext): (password: string, saveToVault: boolean) => Promise<void> {
  return async (password: string, saveToVault: boolean) => {
    if (!controllerContext.pendingAuth) return;
    const session = controllerContext.pendingAuth.session;
    let credential: string = password;

    if (controllerContext.pendingAuth.kind === "jump") {
      let persistJumpPasswordOnTarget = false;
      if (saveToVault) {
        const ready = await ensureVaultReady(tr(SAVED_PASSWORD_VAULT_REASON_KEY));
        if (ready) {
          try {
            const label = `${controllerContext.pendingAuth.username}@${controllerContext.pendingAuth.host}:${controllerContext.pendingAuth.port}`;
            const result = await vaultPut("ssh-password", label, password);
            credential = result.reference;

            if (controllerContext.pendingAuth.jumpSession) {
              const opts = parseSessionOptions(controllerContext.pendingAuth.jumpSession.options_json);
              await controllerContext.updateSession({
                ...controllerContext.pendingAuth.jumpSession,
                options_json: JSON.stringify({ ...opts, passwordRef: result.reference }),
              });
            } else if (controllerContext.pendingAuth.manual) {
              persistJumpPasswordOnTarget = true;
              await controllerContext.updateSession(sessionWithJumpPassword(session, result.reference, true));
            }
          } catch (err) {
            console.error("Failed to save jump host password to vault:", err);
            credential = password;
            persistJumpPasswordOnTarget = false;
          }
        }
      }

      controllerContext.pendingAuth.onResolved(sessionWithJumpPassword(session, credential, persistJumpPasswordOnTarget));
      controllerContext.setPendingAuth(null);
      controllerContext.awaitingManualAuthRef.current = false;
      controllerContext.continueConnectQueueRef.current();
      return;
    }

    if (saveToVault) {
      // Make sure the vault is ready (set master password if empty, unlock if
      // locked) via the on-demand gate before encrypting. If the user cancels
      // the gate, fall back to a one-shot connect with the typed plaintext.
      const ready = await ensureVaultReady(tr(SAVED_PASSWORD_VAULT_REASON_KEY));
      if (ready) {
        try {
          const kind =
            session.session_type === "VNC"
              ? "vnc-password"
              : session.session_type === "RDP"
                ? "rdp-password"
                : "ssh-password";
          const label = `${session.username || "user"}@${session.host || "?"}:${session.port}`;
          const result = await vaultPut(kind, label, password);
          credential = result.reference;

          // Persist the vault reference back into options_json so future
          // connects find it without re-prompting.
          const opts = parseSessionOptions(session.options_json);
          const updated = JSON.stringify({ ...opts, passwordRef: result.reference });
          await controllerContext.updateSession({ ...session, options_json: updated });
        } catch (err) {
          // On any vault error, fall back to one-shot connect with the typed
          // plaintext — don't block the user.
          console.error("Failed to save password to vault:", err);
          credential = password;
        }
      }
    }

    let outcome: ConnectQueueOutcome = "opened";
    if (session.session_type === "SFTP") {
      outcome = controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSftpTab(effectiveSession, "Password", credential));
    } else if (session.session_type === "VNC") {
      controllerContext.openVncTab(session, credential);
    } else if (session.session_type === "RDP") {
      outcome = controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openRdpTab(effectiveSession, credential));
    } else {
      outcome = controllerContext.openAfterJumpPassword(session, (effectiveSession) => controllerContext.openSshTab(effectiveSession, "Password", credential));
    }
    if (outcome === "opened") {
      controllerContext.setPendingAuth(null);
      controllerContext.awaitingManualAuthRef.current = false;
      controllerContext.continueConnectQueueRef.current();
    }
  };
}

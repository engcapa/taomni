import { useState } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import {
  keychainLookupBatch,
  secureCrtDecryptPasswords,
  tabbyDecryptVault,
  type KeychainHit,
  type KeychainQuery,
  type SecureCrtPasswordFailure,
  type SecureCrtPasswordHit,
  type TabbySecret,
} from "../../../lib/ipc";
import { type SessionImportResult } from "../../../lib/sessionImportExport";


export interface UseExternalSessionSecretsContext {
  t: import("../../../lib/i18n").TranslateFn;
}

export function useExternalSessionSecrets(context: UseExternalSessionSecretsContext) {
  const { t } = context;

  const [externalVaultPrompt, setExternalVaultPrompt] = useState<{
    toolName: string;
    title?: string;
    description: string;
    passwordLabel?: string;
    errorMessage: string | null;
    onSubmit: (password: string) => Promise<void>;
    onSkip: () => void;
  } | null>(null);


  /**
   * Recover passwords from third-party tools' OS keychain entries and (when
   * the user enters a master password) their encrypted vault. Returns a new
   * result with extra entries folded into `secrets`. Tool-specific copy comes
   * from `result.externalVault`.
   *
   * For Tabby:
   *   - vault unlock prompt opens if `externalVault.tool === "Tabby"`
   *   - regardless of vault path, the OS keychain is queried for every
   *     password-auth session under `ssh@<host>[:<port>]` / `<user>`
   */
  const enrichTabbyResult = async (
    result: SessionImportResult,
  ): Promise<SessionImportResult> => {
    if (result.externalSecretsTool !== "tabby") return result;

    let vaultSecrets: TabbySecret[] = [];
    if (result.externalVault) {
      vaultSecrets = await promptTabbyVaultUnlock(
        result.externalVault.rawText,
        result.externalVault.description,
      );
    }

    const keychainHits = await lookupTabbyKeychain(result.sessions, vaultSecrets);

    return mergeTabbySecrets(result, vaultSecrets, keychainHits);
  };

  const promptTabbyVaultUnlock = (rawText: string, description: string): Promise<TabbySecret[]> =>
    new Promise((resolve) => {
      const close = (secrets: TabbySecret[]) => {
        setExternalVaultPrompt(null);
        resolve(secrets);
      };
      let attempts = 0;
      setExternalVaultPrompt({
        toolName: "Tabby",
        description,
        errorMessage: null,
        onSkip: () => close([]),
        onSubmit: async (password) => {
          attempts += 1;
          try {
            const response = await tabbyDecryptVault(rawText, password);
            close(response.secrets);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const friendly = msg.includes("tabby_vault_bad_password")
              ? `Incorrect Tabby master password (attempt ${attempts}).`
              : msg.includes("tabby_vault_missing")
                ? "No vault block found in this Tabby config."
                : msg;
            // Throwing keeps the dialog open and surfaces the error inline.
            throw new Error(friendly);
          }
        },
      });
    });

  const lookupTabbyKeychain = async (
    importedSessions: readonly SessionConfig[],
    vaultSecrets: readonly TabbySecret[],
  ): Promise<KeychainHit[]> => {
    const queries: KeychainQuery[] = [];
    const seen = new Set<string>();
    const addQuery = (service: string, account: string) => {
      const key = `${service} ${account}`;
      if (seen.has(key)) return;
      seen.add(key);
      queries.push({ service, account });
    };

    for (const session of importedSessions) {
      if (session.auth_method !== "Password") continue;
      const account = session.username?.trim();
      if (!account) continue;
      const host = session.host.trim();
      if (!host) continue;
      addQuery(`ssh@${host}:${session.port}`, account);
      addQuery(`ssh@${host}`, account);
    }

    for (const secret of vaultSecrets) {
      if (secret.kind === "key-passphrase" && secret.id) {
        addQuery(`ssh-private-key:${secret.id}`, "user");
      }
    }

    if (queries.length === 0) return [];
    try {
      return await keychainLookupBatch(queries);
    } catch (error) {
      // Don't fail the whole import on a missing keyring daemon; degrade
      // gracefully and let the user re-enter passwords manually.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("Keychain lookup failed:", msg);
      return [];
    }
  };

  const mergeTabbySecrets = (
    result: SessionImportResult,
    vaultSecrets: readonly TabbySecret[],
    keychainHits: readonly KeychainHit[],
  ): SessionImportResult => {
    const newSecrets = [...result.secrets];
    const warnings = [...result.warnings];
    const matched = new Set<string>(); // session ids that now have a recovered password
    let recoveredFromVault = 0;
    let recoveredFromKeychain = 0;
    const standalonePassphrases: TabbySecret[] = [];

    for (const session of result.sessions) {
      if (session.auth_method !== "Password") continue;
      // Already had a plaintext password from config.yaml — skip.
      if (newSecrets.some((s) => s.sessionId === session.id && s.kind === "password")) continue;

      const sessionUser = session.username?.trim();
      if (!sessionUser) continue;

      // Try vault first (more authoritative).
      const vaultMatch = vaultSecrets.find((s) =>
        s.kind === "password" &&
        s.host.toLowerCase() === session.host.toLowerCase() &&
        (s.user ?? "").toLowerCase() === sessionUser.toLowerCase() &&
        (s.port == null || s.port === session.port),
      );
      if (vaultMatch && vaultMatch.kind === "password") {
        newSecrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${sessionUser}@${session.host}:${session.port}`,
          value: vaultMatch.value,
          attachment: "session",
        });
        matched.add(session.id);
        recoveredFromVault += 1;
        continue;
      }

      // Fall back to keychain hits.
      const hostKey = session.host.toLowerCase();
      const candidates = [
        `ssh@${hostKey}:${session.port}`,
        `ssh@${hostKey}`,
      ];
      const hit = keychainHits.find((h) =>
        candidates.includes(h.service.toLowerCase()) &&
        h.account.toLowerCase() === sessionUser.toLowerCase() &&
        h.found && h.value,
      );
      if (hit?.value) {
        newSecrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${sessionUser}@${session.host}:${session.port}`,
          value: hit.value,
          attachment: "session",
        });
        matched.add(session.id);
        recoveredFromKeychain += 1;
      }
    }

    for (const secret of vaultSecrets) {
      if (secret.kind === "key-passphrase") standalonePassphrases.push(secret);
    }

    for (const passphrase of standalonePassphrases) {
      if (passphrase.kind !== "key-passphrase") continue;
      const shortId = passphrase.id.slice(0, 8);
      newSecrets.push({
        sessionId: "", // standalone — no session
        kind: "key-passphrase",
        label: t("sessionTree.tabbyPrivateKeyLabel", { id: shortId }),
        value: passphrase.value,
        attachment: "standalone",
      });
    }

    if (recoveredFromVault > 0 || recoveredFromKeychain > 0) {
      warnings.push(
        t("sessionTree.recoveredPasswords", {
          count: recoveredFromVault + recoveredFromKeychain,
          vault: recoveredFromVault,
          keychain: recoveredFromKeychain,
        }),
      );
    }
    if (standalonePassphrases.length > 0) {
      warnings.push(
        t("sessionTree.standaloneTabbyPassphrases", { count: standalonePassphrases.length }),
      );
    }

    return {
      ...result,
      secrets: newSecrets,
      warnings,
      // Clear the prompt — the unlock pass has happened.
      externalVault: undefined,
      externalSecretsTool: undefined,
    };
  };

  const enrichSecureCrtResult = async (
    result: SessionImportResult,
  ): Promise<SessionImportResult> => {
    if (result.externalSecretsTool !== "securecrt") return result;
    const pendingPasswords = result.secureCrtPasswords ?? [];
    if (pendingPasswords.length === 0) {
      return { ...result, externalSecretsTool: undefined };
    }

    const firstPass = await secureCrtDecryptPasswords(
      pendingPasswords.map(({ sessionId, encrypted }) => ({ sessionId, encrypted })),
      "",
    );

    let hits: SecureCrtPasswordHit[] = [...firstPass.secrets];
    let failures: SecureCrtPasswordFailure[] = [...firstPass.failures];
    const needsPassphraseIds = new Set(
      failures.filter((failure) => failure.needsPassphrase).map((failure) => failure.sessionId),
    );

    if (needsPassphraseIds.size > 0) {
      const retryPasswords = pendingPasswords.filter((password) => needsPassphraseIds.has(password.sessionId));
      const retry = await promptSecureCrtPassphraseUnlock(retryPasswords);
      hits = [...hits, ...retry.secrets];
      const retried = new Set(retryPasswords.map((password) => password.sessionId));
      failures = [
        ...failures.filter((failure) => !retried.has(failure.sessionId)),
        ...retry.failures,
      ];
    }

    return mergeSecureCrtSecrets(result, hits, failures);
  };

  const promptSecureCrtPassphraseUnlock = (
    passwords: NonNullable<SessionImportResult["secureCrtPasswords"]>,
  ): Promise<{ secrets: SecureCrtPasswordHit[]; failures: SecureCrtPasswordFailure[]; }> =>
    new Promise((resolve) => {
      const close = (response: { secrets: SecureCrtPasswordHit[]; failures: SecureCrtPasswordFailure[]; }) => {
        setExternalVaultPrompt(null);
        resolve(response);
      };
      let attempts = 0;
      setExternalVaultPrompt({
        toolName: "SecureCRT",
        title: t("sessionTree.secureCrtPassphraseTitle"),
        description: t("sessionTree.secureCrtPassphraseDescription"),
        passwordLabel: t("sessionTree.secureCrtPassphraseLabel"),
        errorMessage: null,
        onSkip: () => close({
          secrets: [],
          failures: passwords.map((password) => ({
            sessionId: password.sessionId,
            error: "securecrt_password_passphrase_skipped",
            needsPassphrase: false,
          })),
        }),
        onSubmit: async (passphrase) => {
          attempts += 1;
          const response = await secureCrtDecryptPasswords(
            passwords.map(({ sessionId, encrypted }) => ({ sessionId, encrypted })),
            passphrase,
          );
          const stillNeedsPassphrase = response.failures.some((failure) => failure.needsPassphrase);
          if (stillNeedsPassphrase && response.secrets.length === 0) {
            throw new Error(t("sessionTree.secureCrtIncorrectPassphrase", { attempt: attempts }));
          }
          close(response);
        },
      });
    });

  const mergeSecureCrtSecrets = (
    result: SessionImportResult,
    hits: readonly SecureCrtPasswordHit[],
    failures: readonly SecureCrtPasswordFailure[],
  ): SessionImportResult => {
    const pendingById = new Map((result.secureCrtPasswords ?? []).map((password) => [password.sessionId, password]));
    const newSecrets = [...result.secrets];
    const warnings = [...result.warnings];
    const seenSecret = new Set(newSecrets.filter((secret) => secret.kind === "password").map((secret) => secret.sessionId));
    let recovered = 0;

    for (const hit of hits) {
      const pending = pendingById.get(hit.sessionId);
      if (!pending || seenSecret.has(hit.sessionId)) continue;
      newSecrets.push({
        sessionId: hit.sessionId,
        kind: "password",
        label: pending.label,
        value: hit.value,
        attachment: "session",
      });
      seenSecret.add(hit.sessionId);
      recovered += 1;
    }

    const unrecovered = failures.filter((failure) => pendingById.has(failure.sessionId)).length;
    if (recovered > 0) {
      warnings.push(t("sessionTree.secureCrtRecoveredPasswords", { count: recovered }));
    }
    if (unrecovered > 0) {
      warnings.push(t("sessionTree.secureCrtUnrecoveredPasswords", { count: unrecovered }));
    }

    return {
      ...result,
      secrets: newSecrets,
      warnings: [...new Set(warnings)],
      secureCrtPasswords: [],
      externalSecretsTool: undefined,
    };
  };
  return { enrichTabbyResult, enrichSecureCrtResult, externalVaultPrompt, setExternalVaultPrompt };
}

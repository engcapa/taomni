import type { SessionImportResult } from "./sessionImportExport";
import { isVaultLockedError, vaultPut } from "./ipc";
import { parseSessionOptions } from "./terminalProfile";
import { ensureVaultReady } from "./vaultGate";

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

const DB_PASSWORD_SESSION_TYPES = new Set([
  "MySQL",
  "PostgreSQL",
  "PanWeiDB",
  "SQLServer",
  "StarRocks",
  "ClickHouse",
  "Presto",
  "Redis",
  "HBaseShell",
]);

export async function prepareImportedSecretsForSave(
  result: SessionImportResult,
  t: TranslateFn,
): Promise<SessionImportResult> {
  if (result.secrets.length === 0) return result;

  const vaultReady = await ensureVaultReady(t("vault.gateReasonSession"));
  if (!vaultReady) {
    return {
      ...result,
      warnings: [...new Set([
        ...result.warnings,
        t("sessionTree.skippedVaultUnlockCancelled", {
          count: result.secrets.length,
          plural: result.secrets.length === 1 ? "" : "s",
        }),
      ])],
      secrets: [],
    };
  }

  const sessionsById = new Map(result.sessions.map((session) => [session.id, { ...session }]));
  const warnings = [...result.warnings];
  let standaloneSaved = 0;
  let standaloneSkipped = 0;

  for (const secret of result.secrets) {
    const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
    if (isStandalone) {
      const kind = secret.kind === "key-passphrase" ? "ssh-key-passphrase" : "ssh-password";
      try {
        await vaultPut(kind, secret.label, secret.value);
        standaloneSaved += 1;
      } catch (error) {
        standaloneSkipped += 1;
        if (isVaultLockedError(error)) {
          warnings.push(t("sessionTree.skippedStandalone"));
        }
      }
      continue;
    }

    const session = sessionsById.get(secret.sessionId);
    if (!session) continue;
    try {
      const kind = secret.kind === "key-passphrase"
        ? "ssh-key-passphrase"
        : DB_PASSWORD_SESSION_TYPES.has(session.session_type) ? "db-password" : "ssh-password";
      const saved = await vaultPut(kind, secret.label, secret.value);
      const parsedOptions = parseSessionOptions(session.options_json);
      session.options_json = JSON.stringify({
        ...parsedOptions,
        passwordRef: saved.reference,
      });
    } catch (error) {
      const reason = isVaultLockedError(error)
        ? t("sessionTree.vaultLockedReason")
        : error instanceof Error ? error.message : String(error);
      warnings.push(t("sessionTree.skippedVaultLocked", { name: session.name, reason }));
    }
  }

  if (standaloneSaved > 0) {
    warnings.push(t("sessionTree.standaloneSaved", { count: standaloneSaved }));
  }
  if (standaloneSkipped > 0) {
    warnings.push(t("sessionTree.standaloneSkipped", { count: standaloneSkipped }));
  }

  return {
    ...result,
    sessions: result.sessions.map((session) => sessionsById.get(session.id) ?? session),
    warnings: [...new Set(warnings)],
    secrets: [],
  };
}

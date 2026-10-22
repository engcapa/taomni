import { useState } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import { type SessionImportResult } from "../../../lib/sessionImportExport";
import { folderOptionLabel } from "../../../lib/sessionPaths";
import { prepareImportedSecretsForSave } from "../../../lib/sessionImportSecrets";

export interface UseSessionImportPreviewContext {
  enrichTabbyResult: (result: SessionImportResult) => Promise<SessionImportResult>;
  enrichSecureCrtResult: (result: SessionImportResult) => Promise<SessionImportResult>;
  importSessions: (configs: SessionConfig[]) => Promise<void>;
  expandPath: (path: string | null | undefined) => void;
  t: import("../../../lib/i18n").TranslateFn;
  setStatusMessage: (message: string) => void;
  reportWarnings: (warnings: string[]) => void;
}


export function useSessionImportPreview(context: UseSessionImportPreviewContext) {
  const { importSessions, expandPath, t, setStatusMessage } = context;

  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    folderPath: string | null;
    source: string;
  } | null>(null);


  const queueImportPreview = (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
  ) => {
    if (result.externalSecretsTool === "tabby") {
      void context.enrichTabbyResult(result)
        .then((enriched) => setPendingImport({ result: enriched, folderPath, source }))
        .catch((error) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    if (result.externalSecretsTool === "securecrt") {
      void context.enrichSecureCrtResult(result)
        .then((enriched) => setPendingImport({ result: enriched, folderPath, source }))
        .catch((error) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    setPendingImport({ result, folderPath, source });
  };


  const confirmPendingImport = async (selectedIds: ReadonlySet<string>) => {
    const pending = pendingImport;
    if (!pending) return;
    const filtered = filterImportResultBySelection(pending.result, selectedIds);
    await applyImportResult(filtered, pending.folderPath, pending.source, { alertWarnings: false });
    setPendingImport(null);
  };

  const filterImportResultBySelection = (
    result: SessionImportResult,
    selectedIds: ReadonlySet<string>,
  ): SessionImportResult => {
    const selectedSessions = result.sessions.filter((session) => selectedIds.has(session.id));
    if (selectedSessions.length === result.sessions.length) return result;
    const selectedSecrets = result.secrets.filter((secret) => {
      // Standalone secrets (e.g. Tabby private-key passphrases without an
      // attached session) live independently of the imported session list,
      // so user-level row selection does not affect them.
      const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
      if (isStandalone) return true;
      return selectedIds.has(secret.sessionId);
    });
    const selectedSecureCrtPasswords = result.secureCrtPasswords?.filter((password) =>
      selectedIds.has(password.sessionId),
    );
    const droppedCount = result.sessions.length - selectedSessions.length;
    return {
      ...result,
      sessions: selectedSessions,
      secrets: selectedSecrets,
      secureCrtPasswords: selectedSecureCrtPasswords,
      skipped: result.skipped + droppedCount,
    };
  };

  const applyImportResult = async (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
    options: { alertWarnings?: boolean; } = {},
  ) => {
    const prepared = await prepareImportResultForSave(result);
    if (prepared.sessions.length > 0) {
      await importSessions(prepared.sessions);
      expandPath(folderPath);
    }
    const hasNewWarnings = prepared.warnings.length > result.warnings.length;
    reportImportResult(source, prepared, folderPath, options.alertWarnings !== false || hasNewWarnings);
  };

  const prepareImportResultForSave = async (result: SessionImportResult): Promise<SessionImportResult> => {
    return prepareImportedSecretsForSave(result, t);
  };

  const reportImportResult = (
    source: string,
    result: SessionImportResult,
    folderPath: string | null,
    alertWarnings = true,
  ) => {
    const target = folderOptionLabel(folderPath);
    const count = result.sessions.length;
    const skipped = result.skipped ? t("sessionTree.skippedSuffix", { count: result.skipped }) : "";
    const warningSuffix = result.warnings.length ? t("sessionTree.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" }) : "";
    setStatusMessage(t("sessionTree.importedCount", { count, source, plural: count === 1 ? "" : "s", target, skipped, warnings: warningSuffix }));
    if (alertWarnings) context.reportWarnings(result.warnings);
  };
  return { queueImportPreview, confirmPendingImport, pendingImport, setPendingImport };
}

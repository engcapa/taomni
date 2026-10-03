import { useState, type ReactNode } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { openBinaryFile, openTextFile, downloadTextFile } from "../../lib/fileHelpers";
import { parseOpenSshConfig } from "../../lib/quickConnect";
import { serializeHtmlSessions } from "../../lib/sessionExportHtml";
import {
  createSessionImportResult,
  parseCsvSessions,
  parseMobaXtermSessions,
  parseTaomniSessions,
  serializeCsvSessions,
  serializeCsvSessionTemplate,
  serializeMobaXtermSessions,
  serializeTaomniSessions,
  type SessionExportResult,
  type SessionImportResult,
} from "../../lib/sessionImportExport";
import { SessionImportPreview } from "../session/SessionImportPreview";
import { t as translate } from "../../lib/i18n";
import { alertAppDialog } from "../../lib/appDialogs";
import { getHomeDir } from "../../lib/ipc";
import { prepareImportedSecretsForSave } from "../../lib/sessionImportSecrets";

/**
 * Session import/export handlers shared by the in-app {@link MenuBar} (used on
 * Windows/Linux) and the native macOS application menu wired from
 * {@link MainLayout}. The import preview dialog lives here too — consumers just
 * render {@link UseSessionImportExport.previewNode} somewhere in their tree.
 */
export interface UseSessionImportExport {
  hasSessions: boolean;
  importJson: () => void;
  importMoba: () => void;
  importCsv: () => void;
  downloadCsvTemplate: () => void;
  importOpenSsh: () => void;
  exportJson: () => void;
  exportMoba: () => void;
  exportCsv: () => void;
  exportHtml: () => void;
  /** Render this where the import preview modal should appear. */
  previewNode: ReactNode;
}

export function useSessionImportExport(): UseSessionImportExport {
  const { sessions, importSessions } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    source: string;
  } | null>(null);
  const hasSessions = sessions.length > 0;

  const queueImportPreview = (result: SessionImportResult, source: string) => {
    setPendingImport({ result, source });
  };

  const confirmPendingImport = async (selectedIds: ReadonlySet<string>) => {
    const pending = pendingImport;
    if (!pending) return;
    const filtered = filterImportResultBySelection(pending.result, selectedIds);
    const prepared = await prepareImportedSecretsForSave(filtered, translate);
    if (prepared.sessions.length > 0) {
      await importSessions(prepared.sessions);
    }
    setStatusMessage(importStatusMessage(pending.source, prepared));
    if (prepared.warnings.length) reportWarnings(prepared.warnings);
    setPendingImport(null);
  };

  const importJson = () => {
    openTextFile(".json,.taomni-sessions.json,.taomni-sessions.json,application/json").then((text) => {
      if (!text) return;
      queueImportPreview(parseTaomniSessions(text, { existingSessions: sessions }), "Taomni");
    }).catch(reportError);
  };

  const importMoba = () => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream").then(async (bytes) => {
      if (!bytes) return;
      const homeDir = await getHomeDir().catch(() => null);
      queueImportPreview(parseMobaXtermSessions(bytes, { existingSessions: sessions, homeDir }), "MobaXterm");
    }).catch(reportError);
  };

  const importCsv = () => {
    openTextFile(".csv,text/csv").then((text) => {
      if (!text) return;
      queueImportPreview(parseCsvSessions(text, { existingSessions: sessions }), "CSV");
    }).catch(reportError);
  };

  const downloadCsvTemplate = () => {
    void (async () => {
      const result = serializeCsvSessionTemplate();
      const savedPath = await downloadTextFile(result.filename, result.text, result.mimeType);
      if (!savedPath) return;
      setStatusMessage(translate("status.csvTemplateDownloaded"));
    })().catch(reportError);
  };

  const importOpenSsh = () => {
    openTextFile(".config,.txt,*").then((text) => {
      if (!text) return;
      const parsed = parseOpenSshConfig(text);
      queueImportPreview(createSessionImportResult(parsed, { existingSessions: sessions }), "OpenSSH");
    }).catch(reportError);
  };

  const exportResult = (format: string, result: SessionExportResult) => {
    void (async () => {
      const savedPath = await downloadTextFile(result.filename, result.text, result.mimeType);
      if (!savedPath) return;
      const count = sessions.length - result.skipped;
      const skipped = result.skipped ? translate("status.skippedSuffix", { count: result.skipped }) : "";
      const warningSuffix = result.warnings.length
        ? translate("status.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" })
        : "";
      setStatusMessage(translate("status.exportedSessions", {
        count,
        format,
        plural: count === 1 ? "" : "s",
        skipped,
        warnings: warningSuffix,
      }));
      if (result.warnings.length) {
        void alertAppDialog({
          title: translate("status.warnings", {
            count: result.warnings.length,
            plural: result.warnings.length === 1 ? "" : "s",
          }),
          message: result.warnings.slice(0, 8).join("\n"),
        });
      }
    })().catch(reportError);
  };

  const exportJson = () => exportResult("Taomni", serializeTaomniSessions(sessions, null));
  const exportMoba = () => exportResult("MobaXterm", serializeMobaXtermSessions(sessions, null));
  const exportCsv = () => exportResult("CSV", serializeCsvSessions(sessions, null));
  const exportHtml = () => exportResult("HTML", serializeHtmlSessions(sessions, null));

  const previewNode = pendingImport ? (
    <SessionImportPreview
      source={pendingImport.source}
      result={pendingImport.result}
      targetFolder={null}
      onCancel={() => setPendingImport(null)}
      onConfirm={(selectedIds) => void confirmPendingImport(selectedIds)}
    />
  ) : null;

  return {
    hasSessions,
    importJson,
    importMoba,
    importCsv,
    downloadCsvTemplate,
    importOpenSsh,
    exportJson,
    exportMoba,
    exportCsv,
    exportHtml,
    previewNode,
  };
}

export function importStatusMessage(source: string, result: SessionImportResult): string {
  const count = result.sessions.length;
  const skipped = result.skipped ? translate("status.skippedSuffix", { count: result.skipped }) : "";
  const warningSuffix = result.warnings.length
    ? translate("status.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" })
    : "";
  return translate("status.importedSessions", {
    count,
    source,
    plural: count === 1 ? "" : "s",
    skipped,
    warnings: warningSuffix,
  });
}

function filterImportResultBySelection(
  result: SessionImportResult,
  selectedIds: ReadonlySet<string>,
): SessionImportResult {
  const selectedSessions = result.sessions.filter((session) => selectedIds.has(session.id));
  if (selectedSessions.length === result.sessions.length) return result;
  const selectedSecrets = result.secrets.filter((secret) => {
    const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
    if (isStandalone) return true;
    return selectedIds.has(secret.sessionId);
  });
  const selectedSecureCrtPasswords = result.secureCrtPasswords?.filter((password) =>
    selectedIds.has(password.sessionId),
  );
  return {
    ...result,
    sessions: selectedSessions,
    secrets: selectedSecrets,
    secureCrtPasswords: selectedSecureCrtPasswords,
    skipped: result.skipped + result.sessions.length - selectedSessions.length,
  };
}

function reportWarnings(warnings: string[]) {
  if (warnings.length === 0) return;
  void alertAppDialog({
    title: translate("status.warnings", {
      count: warnings.length,
      plural: warnings.length === 1 ? "" : "s",
    }),
    message: warnings.slice(0, 8).join("\n"),
  });
}

function reportError(error: unknown) {
  void alertAppDialog({
    title: translate("common.error"),
    message: error instanceof Error ? error.message : String(error),
  });
}

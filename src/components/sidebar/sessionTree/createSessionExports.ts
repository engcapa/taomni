import type { SessionConfig } from "../../../lib/ipc";
import { serializeCsvSessions, serializeCsvSessionTemplate, serializeMobaXtermSessions, serializeTaomniSessions, type SessionExportResult } from "../../../lib/sessionImportExport";
import { downloadTextFile } from "../../../lib/fileHelpers";
import { serializeHtmlSessions } from "../../../lib/sessionExportHtml";
import { folderOptionLabel } from "../../../lib/sessionPaths";
import { sessionsInFolder } from "./model";


export interface CreateSessionExportsContext {
  sessions: SessionConfig[];
  reportFileError: (error: unknown) => void;
  setStatusMessage: (message: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  reportWarnings: (warnings: string[]) => void;
}

export function createSessionExports(context: CreateSessionExportsContext) {
  const { sessions, setStatusMessage, t } = context;

  const exportFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeTaomniSessions(folderSessions, folderPath);
    void saveExportResult("Taomni", result, folderSessions.length, label).catch(context.reportFileError);
  };

  const exportMobaFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeMobaXtermSessions(folderSessions, folderPath);
    void saveExportResult("MobaXterm", result, folderSessions.length - result.skipped, label).catch(context.reportFileError);
  };

  const exportCsvFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeCsvSessions(folderSessions, folderPath);
    void saveExportResult("CSV", result, folderSessions.length - result.skipped, label).catch(context.reportFileError);
  };

  const generateHtml = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeHtmlSessions(folderSessions, folderPath);
    void saveExportResult("HTML", result, folderSessions.length, label).catch(context.reportFileError);
  };

  const downloadCsvTemplate = () => {
    void (async () => {
      const result = serializeCsvSessionTemplate();
      const savedPath = await downloadTextFile(result.filename, result.text, result.mimeType);
      if (!savedPath) return;
      setStatusMessage(t("sessionTree.csvTemplateDownloaded"));
    })().catch(context.reportFileError);
  };

  const saveExportResult = async (
    format: string,
    result: SessionExportResult,
    count: number,
    label: string,
  ): Promise<void> => {
    const savedPath = await downloadTextFile(result.filename, result.text, result.mimeType);
    if (!savedPath) return;
    reportExportResult(format, result, count, label);
  };

  const reportExportResult = (
    format: string,
    result: SessionExportResult,
    count: number,
    label: string,
  ) => {
    const skipped = result.skipped ? t("sessionTree.skippedSuffix", { count: result.skipped }) : "";
    const warningSuffix = result.warnings.length ? t("sessionTree.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" }) : "";
    setStatusMessage(t("sessionTree.exportedCount", { count, format, plural: count === 1 ? "" : "s", label, skipped, warnings: warningSuffix }));
    context.reportWarnings(result.warnings);
  };
  return { downloadCsvTemplate, exportFolder, exportMobaFolder, exportCsvFolder, generateHtml };
}

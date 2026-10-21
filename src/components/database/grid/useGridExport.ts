import { useEffect, useState } from "react";
import { selectSaveFilePath, temporaryFilePath } from "../../../lib/ipc";
import { writeText } from "../../../lib/clipboard";
import { isTauriRuntime } from "../../../lib/runtime";
import { sftpOpenPath } from "../../../lib/sftp";
import { getActiveQueryTab, listQueryTabs } from "../../../lib/queryRegistry";
import { alertAppDialog } from "../../../lib/appDialogs";
import { type GridRow, type ExportTarget, type ExportOptions, type ExportColumnConfig, type ExportDestination } from "./types";
import { readStoredExportOptions, defaultExportColumns, readExportFileHistory, writeExportFileHistory, DEFAULT_EXPORT_OPTIONS } from "./preferences";
import { serializeResult, encodeOutput, browserOpen, writeBytesToPath, browserDownload } from "./export";


export interface UseGridExportContext {
  selectionRows: GridRow[];
  nonDeletedOrderedRows: GridRow[];
  cellBlockRange: { rows: GridRow[]; rowIds: Set<string>; colIdxs: number[]; colIdxSet: Set<number>; } | null;
  setStatus: (message: string) => void;
  result: import("../../../lib/ipc").DbQueryResult;
  sourceSql: string | undefined;
  visibleColumns: Set<number>;
}

export function useGridExport(context: UseGridExportContext) {
  const { selectionRows, nonDeletedOrderedRows, cellBlockRange, setStatus, result, sourceSql, visibleColumns } = context;

  const [exportTarget, setExportTarget] = useState<ExportTarget>("all");
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => readStoredExportOptions());
  const [exportColumns, setExportColumns] = useState<ExportColumnConfig[]>(() => defaultExportColumns(result.columns));
  const [exportDialogOpen, setExportDialogOpen] = useState(false);


  useEffect(() => setExportColumns(defaultExportColumns(result.columns)), [result.columns]);

  const rowsForTarget = (target: ExportTarget): GridRow[] => {
    if (target === "selection" && selectionRows.length > 0) return selectionRows;
    return nonDeletedOrderedRows;
  };

  const columnsForTarget = (target: ExportTarget, columns: ExportColumnConfig[]): ExportColumnConfig[] => {
    if (target !== "selection" || !cellBlockRange) return columns;
    return columns.filter((_, index) => cellBlockRange.colIdxSet.has(index));
  };

  const exportWithOptions = async (
    target: ExportTarget,
    options: ExportOptions,
    columns: ExportColumnConfig[],
    destination?: ExportDestination,
    openAfter = false,
  ) => {
    const rowsToExport = rowsForTarget(target);
    const columnsToExport = columnsForTarget(target, columns);
    if (rowsToExport.length === 0 || columnsToExport.filter((column) => column.export).length === 0) {
      setStatus("No result rows are available for export.");
      return;
    }
    try {
      const serialized = serializeResult(result.columns, rowsToExport, columnsToExport, options, sourceSql);
      const bytes = encodeOutput(serialized.text, options.encoding);
      const filename = `query-results-${Date.now()}.${serialized.extension}`;
      if (openAfter && !isTauriRuntime()) {
        browserOpen(bytes, serialized.mime);
        return;
      }
      if (openAfter && isTauriRuntime()) {
        const path = await temporaryFilePath(filename);
        await writeBytesToPath(path, bytes);
        await sftpOpenPath(path);
        setStatus(`Opened ${rowsToExport.length} row(s) with the system default application.`);
        return;
      }
      if (destination?.kind === "clipboard") {
        await writeText(serialized.text);
        setStatus(`Copied ${rowsToExport.length} exported row(s) to clipboard.`);
        return;
      }
      if (destination?.kind === "sqlCommander") {
        const targetTab =
          destination.sqlCommanderTabId === "active"
            ? getActiveQueryTab()
            : listQueryTabs().find((entry) => entry.tabId === destination.sqlCommanderTabId) ?? getActiveQueryTab();
        if (!targetTab) throw new Error("No SQL Commander editor is available.");
        targetTab.insertQuery(serialized.text, {
          destination: destination.sqlCommanderTabId === "new" ? "new" : "current",
          position: destination.sqlCommanderPosition,
        });
        setStatus(`Sent ${rowsToExport.length} exported row(s) to SQL Commander.`);
        return;
      }
      if (isTauriRuntime()) {
        const requestedPath = destination?.kind === "file" ? destination.filePath.trim() : "";
        const path = requestedPath || (await selectSaveFilePath(filename));
        if (!path) return;
        await writeBytesToPath(path, bytes);
        const nextHistory = [path, ...readExportFileHistory().filter((entry) => entry !== path)];
        writeExportFileHistory(nextHistory);
        setStatus(`Exported ${rowsToExport.length} row(s) to ${path}`);
        return;
      }
      browserDownload(bytes, filename, serialized.mime);
      setStatus(`Exported ${rowsToExport.length} row(s).`);
    } catch (err) {
      const message = `${openAfter ? "Open" : "Export"} failed: ${String(err)}`;
      if (openAfter) {
        await alertAppDialog({
          title: "Open failed",
          message,
        });
      }
      setStatus(message);
    }
  };

  const openSpreadsheet = (target: ExportTarget) => {
    const options: ExportOptions = {
      ...exportOptions,
      outputFormat: "excel",
      includeColumnNames: true,
      maxRows: 0,
    };
    void exportWithOptions(target, options, exportColumns, undefined, true);
  };

  const openBrowser = (target: ExportTarget) => {
    const options: ExportOptions = {
      ...exportOptions,
      outputFormat: "html",
      includeColumnNames: true,
      maxRows: 0,
    };
    void exportWithOptions(target, options, exportColumns, undefined, true);
  };

  const copyRows = async (target: ExportTarget) => {
    const rowsToCopy = rowsForTarget(target);
    if (rowsToCopy.length === 0) return;
    const options = { ...DEFAULT_EXPORT_OPTIONS, outputFormat: "csv" as const, columnDelimiter: "\t" };
    const columnsToCopy = columnsForTarget(target, exportColumns).filter((_, index) => visibleColumns.has(index));
    const serialized = serializeResult(result.columns, rowsToCopy, columnsToCopy, options, sourceSql);
    try {
      await writeText(serialized.text);
      setStatus(`Copied ${rowsToCopy.length} row(s).`);
    } catch (err) {
      setStatus(`Copy failed: ${String(err)}`);
    }
  };
  return { copyRows, openSpreadsheet, openBrowser, rowsForTarget, exportWithOptions, exportTarget, setExportTarget, exportOptions, setExportOptions, exportColumns, setExportColumns, exportDialogOpen, setExportDialogOpen };
}

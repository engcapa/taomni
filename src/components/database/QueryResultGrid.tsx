import { Copy, Edit3, FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { writeText } from "../../lib/clipboard";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { csvEscape } from "./grid/export";
import { isNumeric, makeRows, OVERSCAN, ROW_HEIGHT } from "./grid/model";
import { QueryResultGridView } from "./grid/QueryResultGridView";
import { type CellValueViewer, type GridRow, type QueryResultGridProps, type ViewMode } from "./grid/types";
import { useGridEditing } from "./grid/useGridEditing";
import { useGridExport } from "./grid/useGridExport";
import { useGridFilters } from "./grid/useGridFilters";
import { useGridGeneratedSql } from "./grid/useGridGeneratedSql";
import { useGridSelection } from "./grid/useGridSelection";

/** A virtualised result grid with a compact database-client toolbar. */
export function QueryResultGrid({
  result,
  sourceSql,
  baseSql,
  sqlEngine,
  running = false,
  cancelling = false,
  onRefresh,
  onCancel,
  onCommitChanges,
  onPreviewChanges,
  onGeneratedSqlSync,
  onGeneratedSqlQuery,
  onStatus,
}: QueryResultGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<GridRow[]>(() => makeRows(result));
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const [autoFit, setAutoFit] = useState(true);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [visibleColumns, setVisibleColumns] = useState<Set<number>>(
    () => new Set(result.columns.map((_, index) => index)),
  );
  const [searchText, setSearchText] = useState("");
  const [showStats, setShowStats] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [cellValueViewer, setCellValueViewer] = useState<CellValueViewer | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const { show: openCellMenu, showAt: openMenuAt, render: menu } = useContextMenu();

  useEffect(() => {
    setRows(makeRows(result));
    setCellValueViewer(null);
  }, [result]);

  useEffect(() => {
    setVisibleColumns(new Set(result.columns.map((_, index) => index)));
    setColumnWidths({});
  }, [result.columns]);

  const visibleColumnIndexes = useMemo(
    () => result.columns.map((_, index) => index).filter((index) => visibleColumns.has(index)),
    [result.columns, visibleColumns],
  );

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setScrollLeft(e.currentTarget.scrollLeft);
    setViewportH(e.currentTarget.clientHeight);
  }, []);
  const setStatus = (message: string) => {
    setLocalNotice(message);
    onStatus?.(message);
  };
  const filters = useGridFilters({
    result,
    visibleColumnIndexes,
    rows,
  });
  const {
    generatedSql,
    displayGeneratedSqlTitle,
    generatedSqlBarText,
    generatedSqlActionsDisabled,
    queryGeneratedSql,
    copyGeneratedSql,
    syncGeneratedSql,
  } = useGridGeneratedSql({
    baseSql,
    sourceSql,
    sqlEngine,
    result,
    visibleColumnIndexes,
    filterText: filters.filterText,
    activeColumnFilters: filters.activeColumnFilters,
    sorts: filters.sorts,
    setLocalNotice,
    setStatus,
    onGeneratedSqlQuery,
    onGeneratedSqlSync,
  });
  const selection = useGridSelection({
    result,
    orderedRows: filters.orderedRows,
    visibleColumnIndexes,
    containerRef,
  });
  const nonDeletedOrderedRows = useMemo(
    () => filters.orderedRows.filter((row) => row.status !== "deleted"),
    [filters.orderedRows],
  );
  const changeCounts = useMemo(
    () => ({
      inserted: rows.filter((row) => row.status === "inserted").length,
      updated: rows.filter((row) => row.status === "updated").length,
      deleted: rows.filter((row) => row.status === "deleted").length,
    }),
    [rows],
  );
  const pendingChangeCount = changeCounts.inserted + changeCounts.updated + changeCounts.deleted;

  const searchMatchCount = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) return 0;
    let count = 0;
    for (const row of filters.orderedRows) {
      for (const index of visibleColumnIndexes) {
        if ((row.values[index] ?? "").toLowerCase().includes(needle)) count += 1;
      }
    }
    return count;
  }, [filters.orderedRows, searchText, visibleColumnIndexes]);

  const openDropdown = (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 4, items);
  };

  const columnStyle = (columnIndex: number): CSSProperties => {
    const width = columnWidths[columnIndex];
    if (width) {
      return { flex: `0 0 ${width}px`, minWidth: 56, maxWidth: width };
    }
    return autoFit ? { flex: "1 1 140px", minWidth: 88 } : { flex: "0 0 160px", minWidth: 88 };
  };

  const startColumnResize = (event: MouseEvent<HTMLElement>, columnIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    const parent = event.currentTarget.parentElement;
    const startX = event.clientX;
    const startWidth = Math.max(56, parent?.getBoundingClientRect().width ?? columnWidths[columnIndex] ?? 160);
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const next = Math.max(56, Math.round(startWidth + moveEvent.clientX - startX));
      setColumnWidths((current) => ({ ...current, [columnIndex]: next }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const editSession = useGridEditing({
    selection,
    setRows,
    rows,
    visibleColumnIndexes,
    setStatus,
    result,
    changeCounts,
    onPreviewChanges,
    onCommitChanges,
  });

  const openCellValueViewer = (row: GridRow, colIdx: number): boolean => {
    const column = result.columns[colIdx];
    if (!column || row.status === "deleted") return false;
    const visibleRowIndex = filters.orderedRows.findIndex((candidate) => candidate.id === row.id);
    const fallbackRowIndex = Math.max(0, visibleRowIndex >= 0 ? visibleRowIndex : rows.findIndex((candidate) => candidate.id === row.id));
    setCellValueViewer({
      rowNumber: (row.originalIndex ?? fallbackRowIndex) + 1,
      column,
      value: row.values[colIdx] ?? null,
    });
    return true;
  };

  const openActiveCellValueViewer = (): boolean => {
    const { activeCell } = selection;
    if (!activeCell) return false;
    const row = rows.find((candidate) => candidate.id === activeCell.rowId);
    if (!row) return false;
    return openCellValueViewer(row, activeCell.colIdx);
  };

  const copyCellViewerValue = async (viewer: CellValueViewer) => {
    try {
      await writeText(viewer.value ?? "");
      setStatus("Copied full cell value.");
    } catch (err) {
      setStatus(`Copy failed: ${String(err)}`);
    }
  };
  const exporter = useGridExport({
    selectionRows: selection.selectionRows,
    nonDeletedOrderedRows,
    cellBlockRange: selection.cellBlockRange,
    setStatus,
    result,
    sourceSql,
    visibleColumns,
  });

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { activeCell } = selection;
    if (editSession.editingCell) return;
    if (
      event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (selection.extendCellBlockSelectionByKeyboard(event.key)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Escape" && selection.cellBlockSelection) {
      event.preventDefault();
      selection.setCellBlockSelection(null);
      return;
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "Enter") {
      if (openActiveCellValueViewer()) {
        event.preventDefault();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
      if (selection.selectionRowCount > 0 || activeCell) {
        event.preventDefault();
        if (selection.selectionRowCount > 0) {
          void exporter.copyRows("selection");
        } else if (activeCell) {
          const row = rows.find((candidate) => candidate.id === activeCell.rowId);
          void writeText(row?.values[activeCell.colIdx] ?? "");
          setStatus("Copied cell.");
        }
      }
    }
  };

  const cellMenu = (row: GridRow, colIdx: number): MenuItem[] => [
    ...(selection.cellBlockRange?.rowIds.has(row.id) && selection.cellBlockRange.colIdxSet.has(colIdx)
      ? [
        {
          label: "Copy block selection",
          icon: <Copy className="w-3.5 h-3.5" />,
          onClick: () => void exporter.copyRows("selection"),
        },
        { separator: true, label: "block-selection-separator" },
      ]
      : []),
    {
      label: "View full value",
      icon: <FileText className="w-3.5 h-3.5" />,
      shortcut: "Ctrl+Enter",
      onClick: () => void openCellValueViewer(row, colIdx),
      disabled: row.status === "deleted",
    },
    { separator: true, label: "view-value-separator" },
    {
      label: "Copy cell",
      icon: <Copy className="w-3.5 h-3.5" />,
      onClick: () => void writeText(row.values[colIdx] ?? ""),
    },
    {
      label: "Copy row",
      onClick: () => void writeText(row.values.map((cell) => cell ?? "").join("\t")),
    },
    {
      label: "Copy row as CSV",
      onClick: () => void writeText(row.values.map(csvEscape).join(",")),
    },
    { separator: true, label: "edit-separator" },
    {
      label: "Edit cell",
      icon: <Edit3 className="w-3.5 h-3.5" />,
      onClick: () => editSession.beginEdit(row.id, colIdx, row.values[colIdx]),
      disabled: row.status === "deleted",
    },
  ];

  const columnMenu = (): MenuItem[] => [
    {
      label: "Show all columns",
      onClick: () => setVisibleColumns(new Set(result.columns.map((_, index) => index))),
    },
    {
      label: "Hide all columns",
      onClick: () => setVisibleColumns(new Set()),
    },
    { separator: true, label: "column-separator" },
    ...result.columns.map<MenuItem>((column, index) => ({
      label: column.name,
      checked: visibleColumns.has(index),
      onClick: () =>
        setVisibleColumns((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        }),
    })),
  ];

  const total = filters.orderedRows.length;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = filters.order.slice(startRow, endRow);
  const searchNeedle = searchText.trim().toLowerCase();

  const stats = useMemo(() => {
    return visibleColumnIndexes.map((columnIndex) => {
      const column = result.columns[columnIndex];
      const values = nonDeletedOrderedRows.map((row) => row.values[columnIndex]);
      const nonNull = values.filter((value): value is string => value !== null && value !== "");
      const numeric = nonNull.map(Number).filter((value) => Number.isFinite(value));
      return {
        column,
        count: values.length,
        nulls: values.length - nonNull.length,
        distinct: new Set(nonNull).size,
        min: numeric.length > 0 ? Math.min(...numeric) : nonNull.slice().sort()[0] ?? "",
        max: numeric.length > 0 ? Math.max(...numeric) : nonNull.slice().sort().at(-1) ?? "",
        avg: numeric.length > 0 ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null,
      };
    });
  }, [nonDeletedOrderedRows, result.columns, visibleColumnIndexes]);

  const chartData = useMemo(() => {
    const numericColumn = visibleColumnIndexes.find((index) =>
      nonDeletedOrderedRows.some((row) => isNumeric(row.values[index])),
    );
    if (numericColumn === undefined) return null;
    const labelColumn = visibleColumnIndexes.find((index) => index !== numericColumn) ?? numericColumn;
    const points = nonDeletedOrderedRows.slice(0, 50).map((row, index) => ({
      label: row.values[labelColumn] ?? `Row ${index + 1}`,
      value: Number(row.values[numericColumn]) || 0,
    }));
    const max = Math.max(1, ...points.map((point) => Math.abs(point.value)));
    return { column: result.columns[numericColumn], points, max };
  }, [nonDeletedOrderedRows, result.columns, visibleColumnIndexes]);

  if (result.columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        {result.rowsAffected > 0
          ? `${result.rowsAffected} row(s) affected`
          : "Statement executed. No result set."}
      </div>
    );
  }

  return <QueryResultGridView
    running={running}
    onRefresh={onRefresh}
    openDropdown={openDropdown}
    cancelling={cancelling}
    onCancel={onCancel}
    exporter={exporter}
    selection={selection}
    columnMenu={columnMenu}
    autoFit={autoFit}
    setAutoFit={setAutoFit}
    setShowStats={setShowStats}
    showStats={showStats}
    filters={filters}
    editSession={editSession}
    pendingChangeCount={pendingChangeCount}
    searchText={searchText}
    setSearchText={setSearchText}
    searchMatchCount={searchMatchCount}
    viewMode={viewMode}
    setViewMode={setViewMode}
    rows={rows}
    visibleColumnIndexes={visibleColumnIndexes}
    localNotice={localNotice}
    changeCounts={changeCounts}
    generatedSql={generatedSql}
    displayGeneratedSqlTitle={displayGeneratedSqlTitle}
    generatedSqlBarText={generatedSqlBarText}
    generatedSqlActionsDisabled={generatedSqlActionsDisabled}
    queryGeneratedSql={queryGeneratedSql}
    copyGeneratedSql={copyGeneratedSql}
    syncGeneratedSql={syncGeneratedSql}
    stats={stats}
    scrollLeft={scrollLeft}
    result={result}
    columnStyle={columnStyle}
    startColumnResize={startColumnResize}
    containerRef={containerRef}
    onScroll={onScroll}
    handleGridKeyDown={handleGridKeyDown}
    total={total}
    visible={visible}
    startRow={startRow}
    searchNeedle={searchNeedle}
    openCellMenu={openCellMenu}
    cellMenu={cellMenu}
    nonDeletedOrderedRows={nonDeletedOrderedRows}
    openCellValueViewer={openCellValueViewer}
    chartData={chartData}
    cellValueViewer={cellValueViewer}
    copyCellViewerValue={copyCellViewerValue}
    setCellValueViewer={setCellValueViewer}
    menu={menu}
  />;
}

export { type QueryGeneratedSqlSyncMode, type QueryGridCommitPayload, type QueryGridRowChange, type QueryRefreshMode } from "./grid/types";

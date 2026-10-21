import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, Ban, BarChart3, Check, ChevronDown, Columns2, Copy, Download, Edit3, ExternalLink, FileText, FileSpreadsheet, Filter, List, Loader2, Plus, RefreshCw, RotateCcw, Save, Search, Sigma, Table2, Trash2 } from "lucide-react";
import type { DbResultSqlRewriteRequest } from "../../lib/ipc";
import { dbRewriteResultSql, selectSaveFilePath, temporaryFilePath } from "../../lib/ipc";
import { writeText } from "../../lib/clipboard";
import { isTauriRuntime } from "../../lib/runtime";
import { sftpOpenPath } from "../../lib/sftp";
import { getActiveQueryTab, listQueryTabs } from "../../lib/queryRegistry";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { alertAppDialog, confirmAppDialog } from "../../lib/appDialogs";
import { gridChangeConfirmMessage, type GridChangePreview } from "../../lib/dbGridChanges";
import { type QueryResultGridProps, type GridRow, type SortRule, type GridBlockSelection, type ColumnFilterConfig, type OpenColumnFilter, type ViewMode, type ExportTarget, type ExportOptions, type ExportColumnConfig, type CellValueViewer, type ResolvedGeneratedSql, type ActiveColumnFilter, type ActiveSortDir, type QueryGridRowChange, type QueryGridCommitPayload, type ExportDestination, type QueryGeneratedSqlSyncMode } from "./grid/types";
import { makeRows, filterValueKey, isNumeric, isColumnFilterActive, isGridBlockSelectionMouseEvent, nextRowId, ROW_HEIGHT, OVERSCAN, distinctValuesForColumn } from "./grid/model";
import { DEFAULT_COLUMN_FILTER, readStoredExportOptions, defaultExportColumns, readExportFileHistory, writeExportFileHistory, DEFAULT_EXPORT_OPTIONS, DISTINCT_FILTER_VALUE_LIMIT } from "./grid/preferences";
import { buildGeneratedResultSql, buildResultSqlRewriteRequest, resultSqlRewriteKey, compactSqlForDisplay } from "./grid/generatedSql";
import { statusAfterValueChange, serializeResult, encodeOutput, browserOpen, writeBytesToPath, browserDownload, csvEscape, nowDateText, nowTimeText, nowTimestampText } from "./grid/export";
import { ToolButton, Divider, StatsCell, FragmentStats } from "./grid/chrome";
import { ExportDialog } from "./grid/ExportDialog";
import { CellValueDialog } from "./grid/CellValueDialog";


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
  const columnFilterPopoverRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<GridRow[]>(() => makeRows(result));
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const [sorts, setSorts] = useState<SortRule[]>([]);
  const [autoFit, setAutoFit] = useState(true);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [visibleColumns, setVisibleColumns] = useState<Set<number>>(
    () => new Set(result.columns.map((_, index) => index)),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [cellBlockSelection, setCellBlockSelection] = useState<GridBlockSelection | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<{ rowId: string; colIdx: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ rowId: string; colIdx: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<number, ColumnFilterConfig>>({});
  const [openColumnFilter, setOpenColumnFilter] = useState<OpenColumnFilter | null>(null);
  const [draftColumnFilter, setDraftColumnFilter] = useState<ColumnFilterConfig>(DEFAULT_COLUMN_FILTER);
  const [searchText, setSearchText] = useState("");
  const [showStats, setShowStats] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [exportTarget, setExportTarget] = useState<ExportTarget>("all");
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => readStoredExportOptions());
  const [exportColumns, setExportColumns] = useState<ExportColumnConfig[]>(() => defaultExportColumns(result.columns));
  const [submittingChanges, setSubmittingChanges] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [cellValueViewer, setCellValueViewer] = useState<CellValueViewer | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const [resolvedGeneratedSql, setResolvedGeneratedSql] = useState<ResolvedGeneratedSql | null>(null);
  const { show: openCellMenu, showAt: openMenuAt, render: menu } = useContextMenu();

  useEffect(() => {
    setRows(makeRows(result));
    setSelectedIds(new Set());
    setCellBlockSelection(null);
    setLastSelectedId(null);
    setActiveCell(null);
    setEditingCell(null);
    setCellValueViewer(null);
  }, [result]);

  useEffect(() => {
    setVisibleColumns(new Set(result.columns.map((_, index) => index)));
    setColumnWidths({});
    setColumnFilters({});
    setOpenColumnFilter(null);
    setDraftColumnFilter(DEFAULT_COLUMN_FILTER);
    setCellBlockSelection(null);
    setExportColumns(defaultExportColumns(result.columns));
  }, [result.columns]);

  useEffect(() => {
    if (!openColumnFilter) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (columnFilterPopoverRef.current?.contains(event.target as Node)) return;
      setOpenColumnFilter(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenColumnFilter(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openColumnFilter]);

  useEffect(() => {
    if (!cellBlockSelection?.dragging) return;
    const finishDrag = () => {
      setCellBlockSelection((current) => current ? { ...current, dragging: false } : current);
    };
    document.addEventListener("mouseup", finishDrag);
    return () => document.removeEventListener("mouseup", finishDrag);
  }, [cellBlockSelection?.dragging]);

  const visibleColumnIndexes = useMemo(
    () => result.columns.map((_, index) => index).filter((index) => visibleColumns.has(index)),
    [result.columns, visibleColumns],
  );

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setScrollLeft(e.currentTarget.scrollLeft);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  const activeColumnFiltersFor = useCallback(
    (filters: Record<number, ColumnFilterConfig>): ActiveColumnFilter[] =>
      Object.entries(filters)
        .map(([rawIndex, config]) => ({
          columnIndex: Number(rawIndex),
          text: config.text.trim(),
          mode: config.mode,
          selectedValues: config.selectedValues,
        }))
        .filter(
          (filter) =>
            Number.isInteger(filter.columnIndex) &&
            filter.columnIndex >= 0 &&
            filter.columnIndex < result.columns.length &&
            (filter.text.length > 0 || filter.selectedValues.length > 0),
        ),
    [result.columns.length],
  );

  const activeColumnFilters = useMemo(
    () => activeColumnFiltersFor(columnFilters),
    [activeColumnFiltersFor, columnFilters],
  );

  const activeColumnFilterCount = activeColumnFilters.length;
  const generatedSql = useMemo(
    () =>
      buildGeneratedResultSql({
        sourceSql: baseSql ?? sourceSql,
        currentSql: sourceSql,
        sqlEngine,
        columns: result.columns,
        visibleColumnIndexes,
        globalFilterText: filterText,
        columnFilters: activeColumnFilters,
        sorts,
      }),
    [activeColumnFilters, baseSql, filterText, result.columns, sorts, sourceSql, sqlEngine, visibleColumnIndexes],
  );
  const generatedSqlRewriteRequest = useMemo(
    () =>
      buildResultSqlRewriteRequest({
        sourceSql: baseSql ?? sourceSql,
        currentSql: sourceSql,
        sqlEngine,
        columns: result.columns,
        visibleColumnIndexes,
        globalFilterText: filterText,
        columnFilters: activeColumnFilters,
        sorts,
      }),
    [activeColumnFilters, baseSql, filterText, result.columns, sorts, sourceSql, sqlEngine, visibleColumnIndexes],
  );
  const generatedSqlRewriteKey = useMemo(
    () => resultSqlRewriteKey(generatedSqlRewriteRequest),
    [generatedSqlRewriteRequest],
  );

  useEffect(() => {
    if (!generatedSql || !generatedSqlRewriteRequest || !generatedSqlRewriteKey) {
      setResolvedGeneratedSql(null);
      return;
    }
    let cancelled = false;
    setResolvedGeneratedSql((current) =>
      current?.key === generatedSqlRewriteKey
        ? current
        : {
            key: generatedSqlRewriteKey,
            sql: generatedSql,
            mode: null,
            reason: null,
            pending: true,
          },
    );
    void dbRewriteResultSql(generatedSqlRewriteRequest)
      .then((rewritten) => {
        if (cancelled) return;
        setResolvedGeneratedSql({
          key: generatedSqlRewriteKey,
          sql: rewritten.sql,
          mode: rewritten.mode,
          reason: rewritten.reason,
          pending: false,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const reason = `SQL rewrite preview failed: ${String(err)}`;
        setResolvedGeneratedSql({
          key: generatedSqlRewriteKey,
          sql: null,
          mode: "unsupported",
          reason,
          pending: false,
        });
        setLocalNotice(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [generatedSql, generatedSqlRewriteKey, generatedSqlRewriteRequest]);

  const currentRewrite = resolvedGeneratedSql?.key === generatedSqlRewriteKey ? resolvedGeneratedSql : null;
  const rewriteUnsupported = currentRewrite?.mode === "unsupported";
  const rewritePending = currentRewrite?.pending ?? false;
  const displayGeneratedSql =
    generatedSql && currentRewrite && !rewriteUnsupported ? currentRewrite.sql ?? generatedSql : generatedSql;
  const generatedSqlUnavailableReason =
    rewriteUnsupported ? currentRewrite?.reason ?? "SQL rewrite is not available for this result." : null;
  const displayGeneratedSqlTitle =
    generatedSqlUnavailableReason ?? displayGeneratedSql;
  const generatedSqlActionsDisabled =
    rewritePending || rewriteUnsupported || !displayGeneratedSql || !generatedSqlRewriteRequest;
  const generatedSqlBarText =
    generatedSqlUnavailableReason ?? (displayGeneratedSql ? compactSqlForDisplay(displayGeneratedSql) : "Rewriting SQL...");

  const rowMatchesFilter = useCallback(
    (row: GridRow) => {
      const needle = filterText.trim().toLowerCase();
      if (needle && !visibleColumnIndexes.some((index) => (row.values[index] ?? "").toLowerCase().includes(needle))) {
        return false;
      }
      return activeColumnFilters.every((filter) => {
        const rawValue = row.values[filter.columnIndex] ?? null;
        if (filter.selectedValues.length > 0) {
          const selected = new Set(filter.selectedValues.map(filterValueKey));
          return selected.has(filterValueKey(rawValue));
        }
        if (!filter.text) return true;
        const value = (rawValue ?? "").toLowerCase();
        const columnNeedle = filter.text.toLowerCase();
        return filter.mode === "exact" ? value === columnNeedle : value.includes(columnNeedle);
      });
    },
    [activeColumnFilters, filterText, visibleColumnIndexes],
  );

  const order = useMemo(() => {
    const indexes = rows.map((_, index) => index).filter((index) => rowMatchesFilter(rows[index]));
    if (sorts.length === 0) return indexes;
    const numericByColumn = new Map(
      sorts.map((sort) => [sort.columnIndex, indexes.every((index) => isNumeric(rows[index].values[sort.columnIndex]))]),
    );
    indexes.sort((a, b) => {
      for (const sort of sorts) {
        const va = rows[a].values[sort.columnIndex];
        const vb = rows[b].values[sort.columnIndex];
        let cmp = 0;
        if (va === null && vb === null) cmp = 0;
        else if (va === null) cmp = 1;
        else if (vb === null) cmp = -1;
        else {
          cmp = numericByColumn.get(sort.columnIndex)
            ? Number(va) - Number(vb)
            : va.localeCompare(vb);
        }
        if (cmp !== 0) return sort.dir === "asc" ? cmp : -cmp;
      }
      return a - b;
    });
    return indexes;
  }, [rowMatchesFilter, rows, sorts]);

  const orderedRows = useMemo(() => order.map((index) => rows[index]), [order, rows]);
  const rowsFiltered = orderedRows.length < rows.length;
  const selectedRows = useMemo(
    () => orderedRows.filter((row) => selectedIds.has(row.id) && row.status !== "deleted"),
    [orderedRows, selectedIds],
  );
  const cellBlockRange = useMemo(() => {
    if (!cellBlockSelection) return null;
    const anchorRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.anchor.rowId);
    const focusRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.focus.rowId);
    const anchorCol = visibleColumnIndexes.indexOf(cellBlockSelection.anchor.colIdx);
    const focusCol = visibleColumnIndexes.indexOf(cellBlockSelection.focus.colIdx);
    if (anchorRow < 0 || focusRow < 0 || anchorCol < 0 || focusCol < 0) return null;

    const [rowStart, rowEnd] = anchorRow <= focusRow ? [anchorRow, focusRow] : [focusRow, anchorRow];
    const [colStart, colEnd] = anchorCol <= focusCol ? [anchorCol, focusCol] : [focusCol, anchorCol];
    const rowsInRange = orderedRows
      .slice(rowStart, rowEnd + 1)
      .filter((row) => row.status !== "deleted");
    const colIdxs = visibleColumnIndexes.slice(colStart, colEnd + 1);
    return {
      rows: rowsInRange,
      rowIds: new Set(rowsInRange.map((row) => row.id)),
      colIdxs,
      colIdxSet: new Set(colIdxs),
    };
  }, [cellBlockSelection, orderedRows, visibleColumnIndexes]);
  const selectionRows = cellBlockRange?.rows ?? selectedRows;
  const selectionRowCount = selectionRows.length;
  const nonDeletedOrderedRows = useMemo(
    () => orderedRows.filter((row) => row.status !== "deleted"),
    [orderedRows],
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
    for (const row of orderedRows) {
      for (const index of visibleColumnIndexes) {
        if ((row.values[index] ?? "").toLowerCase().includes(needle)) count += 1;
      }
    }
    return count;
  }, [orderedRows, searchText, visibleColumnIndexes]);

  const nextSortDir = (dir: ActiveSortDir): ActiveSortDir | null => (dir === "asc" ? "desc" : null);
  const toggleSort = (col: number, additive: boolean) => {
    setSorts((current) => {
      const index = current.findIndex((sort) => sort.columnIndex === col);
      if (!additive) {
        if (index < 0) return [{ columnIndex: col, dir: "asc" }];
        const dir = nextSortDir(current[index].dir);
        return dir ? [{ columnIndex: col, dir }] : [];
      }
      if (index < 0) return [...current, { columnIndex: col, dir: "asc" }];
      const dir = nextSortDir(current[index].dir);
      if (!dir) return current.filter((_, sortIndex) => sortIndex !== index);
      return current.map((sort, sortIndex) => (sortIndex === index ? { ...sort, dir } : sort));
    });
  };

  const setStatus = (message: string) => {
    setLocalNotice(message);
    onStatus?.(message);
  };

  const openDropdown = (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 4, items);
  };

  const applyColumnFilter = (columnIndex: number, config: ColumnFilterConfig) => {
    setColumnFilters((current) => {
      const next = { ...current };
      if (isColumnFilterActive(config)) next[columnIndex] = config;
      else delete next[columnIndex];
      return next;
    });
  };

  const updateDraftColumnFilter = (patch: Partial<ColumnFilterConfig>) => {
    setDraftColumnFilter((current) => ({ ...current, ...patch }));
  };

  const toggleDraftColumnFilterValue = (value: string | null) => {
    setDraftColumnFilter((current) => {
      const key = filterValueKey(value);
      const selected = current.selectedValues.some((item) => filterValueKey(item) === key)
        ? current.selectedValues.filter((item) => filterValueKey(item) !== key)
        : [...current.selectedValues, value];
      return { ...current, selectedValues: selected };
    });
  };

  const clearAllFilters = () => {
    setFilterText("");
    setColumnFilters({});
    setOpenColumnFilter(null);
  };

  const openColumnFilterPanel = (event: MouseEvent<HTMLButtonElement>, columnIndex: number) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 280;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360));
    const current = columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
    setDraftColumnFilter({
      text: current.text,
      mode: current.mode,
      selectedValues: [...current.selectedValues],
    });
    setOpenColumnFilter({ columnIndex, left, top });
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

  const startCellBlockSelection = (event: MouseEvent<HTMLElement>, rowId: string, colIdx: number) => {
    if (!isGridBlockSelectionMouseEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = { rowId, colIdx };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(cell);
    setCellBlockSelection({ anchor: cell, focus: cell, dragging: true });
    containerRef.current?.focus();
  };

  const extendCellBlockSelection = (rowId: string, colIdx: number) => {
    setCellBlockSelection((current) => {
      if (!current?.dragging) return current;
      return { ...current, focus: { rowId, colIdx } };
    });
  };

  const extendCellBlockSelectionByKeyboard = (key: string) => {
    const origin = cellBlockSelection?.anchor ?? activeCell;
    const focus = cellBlockSelection?.focus ?? activeCell;
    if (!origin || !focus || orderedRows.length === 0 || visibleColumnIndexes.length === 0) return false;

    const currentRowPos = orderedRows.findIndex((row) => row.id === focus.rowId);
    const currentColPos = visibleColumnIndexes.indexOf(focus.colIdx);
    if (currentRowPos < 0 || currentColPos < 0) return false;

    let nextRowPos = currentRowPos;
    let nextColPos = currentColPos;
    if (key === "ArrowUp") nextRowPos -= 1;
    if (key === "ArrowDown") nextRowPos += 1;
    if (key === "ArrowLeft") nextColPos -= 1;
    if (key === "ArrowRight") nextColPos += 1;
    nextRowPos = Math.max(0, Math.min(orderedRows.length - 1, nextRowPos));
    nextColPos = Math.max(0, Math.min(visibleColumnIndexes.length - 1, nextColPos));

    const next = {
      rowId: orderedRows[nextRowPos].id,
      colIdx: visibleColumnIndexes[nextColPos],
    };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(next);
    setCellBlockSelection({ anchor: origin, focus: next, dragging: false });
    return true;
  };

  const selectRow = (rowId: string, event: MouseEvent<HTMLElement>) => {
    setCellBlockSelection(null);
    const orderedIds = orderedRows.map((row) => row.id);
    setSelectedIds((current) => {
      if (event.shiftKey && lastSelectedId && orderedIds.includes(lastSelectedId)) {
        const from = orderedIds.indexOf(lastSelectedId);
        const to = orderedIds.indexOf(rowId);
        const [start, end] = from < to ? [from, to] : [to, from];
        const next = new Set(current);
        orderedIds.slice(start, end + 1).forEach((id) => next.add(id));
        return next;
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(current);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }
      return new Set([rowId]);
    });
    setLastSelectedId(rowId);
  };

  const updateCell = (rowId: string, colIdx: number, value: string | null) => {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== rowId || row.status === "deleted") return row;
        const values = [...row.values];
        values[colIdx] = value;
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
  };

  const beginEdit = (rowId: string, colIdx: number, currentValue: string | null) => {
    setActiveCell({ rowId, colIdx });
    setEditingCell({ rowId, colIdx });
    setEditValue(currentValue ?? "");
  };

  const commitEdit = () => {
    if (!editingCell) return;
    updateCell(editingCell.rowId, editingCell.colIdx, editValue);
    setEditingCell(null);
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  const targetCellPositions = useCallback(() => {
    if (activeCell) {
      const targetIds = selectedIds.size > 0 ? selectedIds : new Set([activeCell.rowId]);
      return rows
        .filter((row) => targetIds.has(row.id) && row.status !== "deleted")
        .map((row) => ({ rowId: row.id, colIdx: activeCell.colIdx }));
    }
    if (selectedIds.size > 0) {
      return rows
        .filter((row) => selectedIds.has(row.id) && row.status !== "deleted")
        .flatMap((row) => visibleColumnIndexes.map((colIdx) => ({ rowId: row.id, colIdx })));
    }
    return [];
  }, [activeCell, rows, selectedIds, visibleColumnIndexes]);

  const applyValueToTargets = (valueFactory: () => string | null) => {
    const targets = targetCellPositions();
    if (targets.length === 0) {
      setStatus("Select a row or cell before applying an edit value.");
      return;
    }
    setRows((current) =>
      current.map((row) => {
        const rowTargets = targets.filter((target) => target.rowId === row.id);
        if (rowTargets.length === 0 || row.status === "deleted") return row;
        const values = [...row.values];
        for (const target of rowTargets) {
          values[target.colIdx] = valueFactory();
        }
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
    setStatus(`Edited ${targets.length} cell(s).`);
  };

  const addRow = () => {
    const row: GridRow = {
      id: nextRowId("inserted"),
      originalIndex: null,
      values: result.columns.map(() => null),
      original: null,
      status: "inserted",
    };
    setRows((current) => [...current, row]);
    setSelectedIds(new Set([row.id]));
    setCellBlockSelection(null);
    setActiveCell(result.columns.length > 0 ? { rowId: row.id, colIdx: 0 } : null);
    setStatus("Added a new grid row.");
  };

  const duplicateRows = () => {
    const sources =
      selectedRows.length > 0
        ? selectedRows
        : activeCell
          ? rows.filter((row) => row.id === activeCell.rowId && row.status !== "deleted")
          : [];
    if (sources.length === 0) {
      setStatus("Select at least one row to duplicate.");
      return;
    }
    const copies = sources.map<GridRow>((row) => ({
      id: nextRowId("copy"),
      originalIndex: null,
      values: [...row.values],
      original: null,
      status: "inserted",
    }));
    setRows((current) => [...current, ...copies]);
    setSelectedIds(new Set(copies.map((row) => row.id)));
    setStatus(`Duplicated ${copies.length} row(s).`);
  };

  const deleteRows = () => {
    const targetIds = selectedIds.size > 0 ? selectedIds : activeCell ? new Set([activeCell.rowId]) : new Set<string>();
    if (targetIds.size === 0) {
      setStatus("Select at least one row to delete.");
      return;
    }
    setRows((current) =>
      current
        .filter((row) => !(targetIds.has(row.id) && row.status === "inserted"))
        .map((row) => (targetIds.has(row.id) ? { ...row, status: "deleted" } : row)),
    );
    setSelectedIds(new Set());
    setActiveCell(null);
    setStatus(`Marked ${targetIds.size} row(s) for deletion.`);
  };

  const undoChanges = () => {
    setRows(makeRows(result));
    setSelectedIds(new Set());
    setActiveCell(null);
    setEditingCell(null);
    setStatus("Reverted unsubmitted grid changes.");
  };

  const submitChanges = async () => {
    const changes: QueryGridRowChange[] = rows
      .filter((row) => row.status !== "clean")
      .map((row) => ({
        status: row.status as QueryGridRowChange["status"],
        originalIndex: row.originalIndex,
        values: [...row.values],
        original: row.original ? [...row.original] : null,
      }));
    if (changes.length === 0) return;
    const payload: QueryGridCommitPayload = { columns: result.columns, changes, counts: changeCounts };
    let preview: GridChangePreview | null = null;
    try {
      preview = onPreviewChanges ? await onPreviewChanges(payload) : null;
    } catch {
      // Not previewable (e.g. not a simple SELECT); the submit reports why.
      preview = null;
    }
    const ok = await confirmAppDialog({
      title: "Apply grid changes",
      message: gridChangeConfirmMessage(changeCounts, preview),
      confirmLabel: "Apply",
      danger: changeCounts.deleted > 0,
    });
    if (!ok) {
      setStatus("Grid change submit canceled.");
      return;
    }
    if (!onCommitChanges) {
      setStatus("This result sheet cannot be written back because no editable table metadata is available.");
      return;
    }
    setSubmittingChanges(true);
    try {
      await onCommitChanges(payload);
      const keptRows = rows.filter((row) => row.status !== "deleted");
      setRows(
        keptRows.map((row, index) => ({
          id: `row-${index}-${keptRows.length}`,
          originalIndex: index,
          values: [...row.values],
          original: [...row.values],
          status: "clean",
        })),
      );
      setSelectedIds(new Set());
      setCellBlockSelection(null);
      setActiveCell(null);
      setStatus(`Submitted ${changes.length} grid change(s).`);
    } catch (err) {
      setStatus(`Submit failed: ${String(err)}`);
    } finally {
      setSubmittingChanges(false);
    }
  };

  const openCellValueViewer = (row: GridRow, colIdx: number): boolean => {
    const column = result.columns[colIdx];
    if (!column || row.status === "deleted") return false;
    const visibleRowIndex = orderedRows.findIndex((candidate) => candidate.id === row.id);
    const fallbackRowIndex = Math.max(0, visibleRowIndex >= 0 ? visibleRowIndex : rows.findIndex((candidate) => candidate.id === row.id));
    setCellValueViewer({
      rowNumber: (row.originalIndex ?? fallbackRowIndex) + 1,
      column,
      value: row.values[colIdx] ?? null,
    });
    return true;
  };

  const openActiveCellValueViewer = (): boolean => {
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

  const resolveGeneratedSql = async (
    sql: string | null = generatedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ): Promise<string | null> => {
    if (!sql) return null;
    const key = resultSqlRewriteKey(request);
    if (key && resolvedGeneratedSql?.key === key && !resolvedGeneratedSql.pending) {
      if (resolvedGeneratedSql.mode === "inline" && resolvedGeneratedSql.sql) return resolvedGeneratedSql.sql;
      setStatus(resolvedGeneratedSql.reason ?? "SQL rewrite is not available for this result.");
      return null;
    }
    if (!request) return sql;
    try {
      const rewritten = await dbRewriteResultSql(request);
      setResolvedGeneratedSql({
        key,
        sql: rewritten.sql,
        mode: rewritten.mode,
        reason: rewritten.reason,
        pending: false,
      });
      if (rewritten.mode === "inline" && rewritten.sql) return rewritten.sql;
      setStatus(rewritten.reason ?? "SQL rewrite is not available for this result.");
      return null;
    } catch (err) {
      setResolvedGeneratedSql({
        key,
        sql: null,
        mode: null,
        reason: null,
        pending: false,
      });
      setStatus(`SQL rewrite failed: ${String(err)}`);
      return null;
    }
  };

  const copyGeneratedSql = async () => {
    const sql = await resolveGeneratedSql();
    if (!sql) return;
    try {
      await writeText(sql);
      setStatus("Copied generated SQL.");
    } catch (err) {
      setStatus(`Copy generated SQL failed: ${String(err)}`);
    }
  };

  const queryGeneratedSql = (
    sql = displayGeneratedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ) => {
    if (!sql) {
      setStatus("No local filter or sort changes to query.");
      return;
    }
    if (onGeneratedSqlQuery) {
      void Promise.resolve(onGeneratedSqlQuery(sql, request ?? undefined)).catch((err) => {
        setStatus(`Query generated SQL failed: ${String(err)}`);
      });
      return;
    }
    void syncGeneratedSql("sync", sql, request);
  };

  const syncGeneratedSql = async (
    mode: QueryGeneratedSqlSyncMode,
    sql = displayGeneratedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ) => {
    const resolvedSql = await resolveGeneratedSql(sql, request);
    if (!resolvedSql) return;
    if (onGeneratedSqlSync) {
      onGeneratedSqlSync(resolvedSql, mode);
      return;
    }
    const targetTab = getActiveQueryTab() ?? listQueryTabs().find((entry) => entry.engine === sqlEngine);
    if (!targetTab) {
      setStatus("No SQL Commander editor is available.");
      return;
    }
    targetTab.insertQuery(resolvedSql, { destination: "current", position: "last" });
    setStatus("Inserted generated SQL in SQL Commander.");
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editingCell) return;
    if (
      event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (extendCellBlockSelectionByKeyboard(event.key)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Escape" && cellBlockSelection) {
      event.preventDefault();
      setCellBlockSelection(null);
      return;
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "Enter") {
      if (openActiveCellValueViewer()) {
        event.preventDefault();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
      if (selectionRowCount > 0 || activeCell) {
        event.preventDefault();
        if (selectionRowCount > 0) {
          void copyRows("selection");
        } else if (activeCell) {
          const row = rows.find((candidate) => candidate.id === activeCell.rowId);
          void writeText(row?.values[activeCell.colIdx] ?? "");
          setStatus("Copied cell.");
        }
      }
    }
  };

  const cellMenu = (row: GridRow, colIdx: number): MenuItem[] => [
    ...(cellBlockRange?.rowIds.has(row.id) && cellBlockRange.colIdxSet.has(colIdx)
      ? [
          {
            label: "Copy block selection",
            icon: <Copy className="w-3.5 h-3.5" />,
            onClick: () => void copyRows("selection"),
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
      onClick: () => beginEdit(row.id, colIdx, row.values[colIdx]),
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

  const total = orderedRows.length;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = order.slice(startRow, endRow);
  const searchNeedle = searchText.trim().toLowerCase();
  const openFilterColumnIndex = openColumnFilter?.columnIndex ?? null;
  const openFilterColumn = openFilterColumnIndex !== null ? result.columns[openFilterColumnIndex] : null;
  const openFilterConfig = openFilterColumnIndex !== null
    ? draftColumnFilter
    : DEFAULT_COLUMN_FILTER;
  const openFilterDistinctValues = useMemo(
    () => {
      if (openFilterColumnIndex === null) return { values: [], total: 0, truncated: false };
      const summary = distinctValuesForColumn(rows, openFilterColumnIndex);
      const needle = draftColumnFilter.text.trim().toLowerCase();
      if (!needle) return summary;
      return {
        ...summary,
        values: summary.values.filter((item) => item.label.toLowerCase().includes(needle)),
      };
    },
    [draftColumnFilter.text, openFilterColumnIndex, rows],
  );
  const openFilterSelectedKeys = new Set(openFilterConfig.selectedValues.map(filterValueKey));
  const filterModeButtonStyle = (active: boolean): CSSProperties | undefined =>
    active
      ? {
          background: "var(--taomni-selected)",
          borderColor: "var(--taomni-selected-border)",
          color: "var(--taomni-accent)",
        }
      : undefined;
  const applyLocalColumnFilter = () => {
    if (openFilterColumnIndex === null) return;
    applyColumnFilter(openFilterColumnIndex, draftColumnFilter);
    setOpenColumnFilter(null);
  };

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

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      data-testid="query-result-grid"
      style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
    >
      <div
        className="min-h-8 shrink-0 flex flex-wrap items-center gap-1 px-1 py-1"
        style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        <ToolButton
          title="Refresh result"
          disabled={running || !onRefresh}
          onClick={() => onRefresh?.("normal")}
          icon={running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Refresh mode"
          disabled={running || !onRefresh}
          onClick={(event) =>
            openDropdown(event, [
              { label: "Refresh", onClick: () => onRefresh?.("normal") },
              { label: "Refresh with current row limit", onClick: () => onRefresh?.("currentLimit") },
              { label: "Clear view and refresh", onClick: () => onRefresh?.("clearView") },
            ])
          }
          icon={<ChevronDown className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Stop query"
          disabled={!running || cancelling || !onCancel}
          onClick={() => onCancel?.()}
          icon={cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
        />
        <Divider />
        <ToolButton
          title="Export"
          onClick={(event) =>
            openDropdown(event, [
              {
                label: "Export...",
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => {
                  setExportTarget("all");
                  setExportDialogOpen(true);
                },
              },
              {
                label: "Export Selection...",
                icon: <Download className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => {
                  setExportTarget("selection");
                  setExportDialogOpen(true);
                },
              },
            ])
          }
          icon={<Download className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <ToolButton
          title="Open externally"
          onClick={(event) =>
            openDropdown(event, [
              {
                label: "Open as Spreadsheet...",
                shortcut: "Ctrl+Alt+X",
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                onClick: () => openSpreadsheet("all"),
              },
              {
                label: "Open Selection as Spreadsheet...",
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => openSpreadsheet("selection"),
              },
              { separator: true, label: "open-separator" },
              {
                label: "Open in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                onClick: () => openBrowser("all"),
              },
              {
                label: "Open Selection in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => openBrowser("selection"),
              },
            ])
          }
          icon={<ExternalLink className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <Divider />
        <ToolButton
          title="Show or hide columns"
          onClick={(event) => openDropdown(event, columnMenu())}
          icon={<Columns2 className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title={autoFit ? "Use fixed column width" : "Auto-fit column width"}
          onClick={() => setAutoFit((value) => !value)}
          active={autoFit}
          icon={<Columns2 className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Aggregate statistics"
          onClick={() => setShowStats((value) => !value)}
          active={showStats}
          icon={<Sigma className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Filter rows"
          onClick={() => setFilterOpen((value) => !value)}
          active={filterOpen || !!filterText.trim() || activeColumnFilterCount > 0}
          icon={<Filter className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Copy result"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Copy Results", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => void copyRows("all") },
              {
                label: "Copy Selection",
                icon: <Copy className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => void copyRows("selection"),
              },
            ])
          }
          icon={<Copy className="w-3.5 h-3.5" />}
        />
        <Divider />
        <ToolButton title="Add row" onClick={addRow} icon={<Plus className="w-3.5 h-3.5" />} />
        <ToolButton title="Duplicate row" onClick={duplicateRows} icon={<Copy className="w-3.5 h-3.5" />} />
        <ToolButton title="Delete row" onClick={deleteRows} icon={<Trash2 className="w-3.5 h-3.5" />} />
        <ToolButton
          title="Set value"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Set to Current Date (yyyy-MM-dd)", onClick: () => applyValueToTargets(nowDateText) },
              { label: "Set to Current Time (HH:mm:ss)", onClick: () => applyValueToTargets(nowTimeText) },
              { label: "Set to Current Timestamp (yyyy-MM-dd HH:mm:ss)", onClick: () => applyValueToTargets(nowTimestampText) },
              { label: "Set to UUID (36 chars)", onClick: () => applyValueToTargets(() => crypto.randomUUID?.() ?? nextRowId("uuid")) },
              { label: "Set to Empty String", onClick: () => applyValueToTargets(() => "") },
              { label: 'Set to NULL "(null)"', onClick: () => applyValueToTargets(() => null) },
            ])
          }
          icon={<Edit3 className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <ToolButton
          title="Submit grid edits"
          disabled={pendingChangeCount === 0 || submittingChanges}
          onClick={() => void submitChanges()}
          icon={submittingChanges ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Undo unsubmitted edits"
          disabled={pendingChangeCount === 0}
          onClick={undoChanges}
          icon={<RotateCcw className="w-3.5 h-3.5" />}
        />
        <Divider />
        {filterOpen && (
          <label className="h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
            <Filter className="w-3.5 h-3.5" />
            <input
              type="search"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              className="taomni-input h-6 w-[150px] text-[11px]"
              placeholder="Filter rows"
              aria-label="Filter rows"
            />
          </label>
        )}
        {(filterText.trim() || activeColumnFilterCount > 0) && (
          <button
            type="button"
            className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            title="Clear filters"
            onClick={clearAllFilters}
          >
            <Ban className="w-3.5 h-3.5" />
            {activeColumnFilterCount > 0 ? `${activeColumnFilterCount} col` : "Clear"}
          </button>
        )}
        <label className="ml-auto h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
          <Search className="w-3.5 h-3.5" />
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className="taomni-input h-6 w-[150px] text-[11px]"
            placeholder="Search"
            aria-label="Search result set"
          />
          {searchText && <span className="min-w-6 text-right">{searchMatchCount}</span>}
        </label>
        <div
          className="h-6 inline-flex items-center rounded"
          style={{ border: "1px solid var(--taomni-divider)", overflow: "hidden" }}
        >
          <ToolButton title="Table view" active={viewMode === "table"} onClick={() => setViewMode("table")} icon={<Table2 className="w-3.5 h-3.5" />} />
          <ToolButton title="List view" active={viewMode === "list"} onClick={() => setViewMode("list")} icon={<List className="w-3.5 h-3.5" />} />
          <ToolButton title="Chart view" active={viewMode === "chart"} onClick={() => setViewMode("chart")} icon={<BarChart3 className="w-3.5 h-3.5" />} />
        </div>
        {/* DbVisualizer-style count: shown [total]/columns while client filters hide rows. */}
        <span
          data-testid="query-result-row-count"
          data-filtered={rowsFiltered ? "true" : "false"}
          className="px-1 text-[10px] tabular-nums text-[var(--taomni-text-muted)]"
          title={rowsFiltered ? "Rows shown [total rows] / columns" : "Rows / columns"}
        >
          {rowsFiltered ? `${orderedRows.length} [${rows.length}]` : rows.length}/{visibleColumnIndexes.length}
        </span>
        {(pendingChangeCount > 0 || localNotice) && (
          <span className="max-w-[320px] truncate px-1 text-[10px] text-[var(--taomni-text-muted)]" title={localNotice}>
            {pendingChangeCount > 0
              ? `${changeCounts.inserted} add / ${changeCounts.updated} edit / ${changeCounts.deleted} delete`
              : localNotice}
          </span>
        )}
      </div>

      {generatedSql && (
        <div
          data-testid="query-result-generated-sql-bar"
          className="min-h-7 shrink-0 flex items-center gap-1.5 px-2 py-1 text-[11px]"
          style={{ background: "var(--taomni-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
        >
          <FileText className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="shrink-0 font-semibold text-[var(--taomni-text-muted)]">SQL</span>
          <code
            data-testid="query-result-generated-sql"
            className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{ background: "var(--taomni-quick-bg)", border: "1px solid var(--taomni-divider)" }}
            title={displayGeneratedSqlTitle ?? undefined}
          >
            {generatedSqlBarText}
          </code>
          <button
            type="button"
            data-testid="query-result-generated-sql-query"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            data-primary="true"
            title="Apply local filters and sort as a database query"
            aria-label="Query generated SQL"
            disabled={running || cancelling || generatedSqlActionsDisabled}
            onClick={() => queryGeneratedSql()}
          >
            <Check className="w-3.5 h-3.5" />
            Query
          </button>
          <button
            type="button"
            data-testid="query-result-generated-sql-copy"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            title="Copy generated SQL"
            aria-label="Copy generated SQL"
            disabled={generatedSqlActionsDisabled}
            onClick={() => void copyGeneratedSql()}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy
          </button>
          <button
            type="button"
            data-testid="query-result-generated-sql-sync"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            title="Sync generated SQL to a query editor"
            aria-label="Sync generated SQL"
            disabled={generatedSqlActionsDisabled}
            onClick={() => void syncGeneratedSql("sync")}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Sync
          </button>
        </div>
      )}

      {showStats && (
        <div
          className="max-h-[132px] shrink-0 overflow-auto taomni-scroll-y text-[11px]"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-bg)" }}
        >
          <div className="min-w-full inline-grid grid-cols-[minmax(120px,1fr)_repeat(6,minmax(70px,auto))]">
            <StatsCell header>Column</StatsCell>
            <StatsCell header>Rows</StatsCell>
            <StatsCell header>Null</StatsCell>
            <StatsCell header>Distinct</StatsCell>
            <StatsCell header>Min</StatsCell>
            <StatsCell header>Max</StatsCell>
            <StatsCell header>Avg</StatsCell>
            {stats.map((stat, index) => (
              <FragmentStats key={`${stat.column.name}-${index}`} stat={stat} />
            ))}
          </div>
        </div>
      )}

      {viewMode === "table" && (
        <>
          <div
            className="shrink-0 overflow-hidden select-none"
            style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
          >
            <div
              data-testid="query-result-grid-header-scroll"
              className="flex text-[11px] font-semibold"
              style={{
                fontSize: "var(--taomni-db-font-size-sm, 11px)",
                transform: `translateX(${-scrollLeft}px)`,
                willChange: "transform",
              }}
            >
              <div
                className="w-12 px-1 py-1 text-[var(--taomni-text-muted)] shrink-0 flex items-center justify-between"
                style={{ borderRight: "1px solid var(--taomni-divider)" }}
              >
                <span>#</span>
                <span className="text-[10px]">{selectionRowCount || ""}</span>
              </div>
              {visibleColumnIndexes.map((columnIndex) => {
                const col = result.columns[columnIndex];
                const columnFilter = columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
                const columnFiltered = isColumnFilterActive(columnFilter);
                const sortIndex = sorts.findIndex((sort) => sort.columnIndex === columnIndex);
                const columnSort = sortIndex >= 0 ? sorts[sortIndex] : null;
                return (
                  <div
                    key={columnIndex}
                    className="group relative px-2 py-1 text-left flex items-center gap-1 hover:bg-[var(--taomni-hover)]"
                    style={{ ...columnStyle(columnIndex), borderRight: "1px solid var(--taomni-divider)" }}
                    title={`${col.name} (${col.type})`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex flex-1 items-center gap-1 bg-transparent p-0 text-left"
                      data-testid="query-result-sort-header"
                      data-column={col.name}
                      data-sort={columnSort?.dir ?? "none"}
                      onClick={(event) => toggleSort(columnIndex, event.shiftKey)}
                    >
                      <span className="truncate flex-1">{col.name}</span>
                      {columnSort?.dir === "asc" && <ArrowUp className="w-3 h-3" />}
                      {columnSort?.dir === "desc" && <ArrowDown className="w-3 h-3" />}
                      {sorts.length > 1 && sortIndex >= 0 && (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[9px] text-[var(--taomni-accent)]" style={{ background: "var(--taomni-selected)" }}>
                          {sortIndex + 1}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={`mr-1 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded transition-all hover:bg-[var(--taomni-hover)] ${
                        columnFiltered
                          ? "opacity-100 text-[var(--taomni-accent)] shadow-sm"
                          : "opacity-0 translate-y-0.5 text-[var(--taomni-text-muted)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
                      }`}
                      style={columnFiltered ? { background: "var(--taomni-selected)" } : undefined}
                      title={`Filter ${col.name}`}
                      aria-label={`Filter column ${col.name}`}
                      onClick={(event) => openColumnFilterPanel(event, columnIndex)}
                    >
                      <Filter className="w-3 h-3" />
                    </button>
                    <span
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--taomni-accent)]"
                      onMouseDown={(event) => startColumnResize(event, columnIndex)}
                      title="Resize column"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div
            ref={containerRef}
            data-testid="query-result-grid-scroll"
            className="flex-1 min-h-0 overflow-auto taomni-scroll-y"
            tabIndex={0}
            onScroll={onScroll}
            onKeyDown={handleGridKeyDown}
          >
            <div style={{ height: total * ROW_HEIGHT, position: "relative" }}>
              {visible.map((rowIndex, i) => {
                const row = rows[rowIndex];
                const top = (startRow + i) * ROW_HEIGHT;
                const selected = selectedIds.has(row.id);
                return (
                  <div
                    key={row.id}
                    data-testid="query-result-row"
                    className="flex absolute left-0 right-0"
                    style={{
                      top,
                      height: ROW_HEIGHT,
                      borderBottom: "1px solid var(--taomni-divider)",
                      background: selected
                        ? "var(--taomni-selected)"
                        : row.status === "deleted"
                          ? "rgba(217, 83, 79, 0.12)"
                          : row.status === "inserted"
                            ? "rgba(98, 211, 111, 0.10)"
                            : row.status === "updated"
                              ? "rgba(230, 168, 23, 0.10)"
                              : undefined,
                      opacity: row.status === "deleted" ? 0.65 : undefined,
                    }}
                  >
                    <button
                      type="button"
                      className="w-12 px-1 text-right text-[var(--taomni-text-muted)] shrink-0 flex items-center justify-end hover:bg-[var(--taomni-hover)]"
                      style={{ borderRight: "1px solid var(--taomni-divider)" }}
                      onClick={(event) => selectRow(row.id, event)}
                      title={row.status === "clean" ? `Row ${(row.originalIndex ?? rowIndex) + 1}` : row.status}
                    >
                      <span className="mr-1 text-[10px]">
                        {row.status === "inserted" ? "+" : row.status === "updated" ? "~" : row.status === "deleted" ? "-" : ""}
                      </span>
                      {(row.originalIndex ?? rowIndex) + 1}
                    </button>
                    {visibleColumnIndexes.map((columnIndex) => {
                      const cell = row.values[columnIndex];
                      const active = activeCell?.rowId === row.id && activeCell.colIdx === columnIndex;
                      const editing = editingCell?.rowId === row.id && editingCell.colIdx === columnIndex;
                      const searchHit = !!searchNeedle && (cell ?? "").toLowerCase().includes(searchNeedle);
                      const blockSelected = !!cellBlockRange?.rowIds.has(row.id) && cellBlockRange.colIdxSet.has(columnIndex);
                      return (
                        <div
                          key={columnIndex}
                          className={`px-2 flex items-center truncate ${
                            isNumeric(cell) ? "justify-end font-mono" : ""
                          }`}
                          style={{
                            ...columnStyle(columnIndex),
                            borderRight: "1px solid var(--taomni-divider)",
                            outline: active ? "1px solid var(--taomni-accent)" : undefined,
                            background: blockSelected
                              ? "var(--taomni-editor-selection-bg)"
                              : searchHit
                                ? "rgba(230, 168, 23, 0.22)"
                                : undefined,
                          }}
                          title={cell ?? "NULL"}
                          onMouseDown={(event) => startCellBlockSelection(event, row.id, columnIndex)}
                          onMouseEnter={() => extendCellBlockSelection(row.id, columnIndex)}
                          onClick={(event) => {
                            if (event.altKey) return;
                            setCellBlockSelection(null);
                            setActiveCell({ rowId: row.id, colIdx: columnIndex });
                            selectRow(row.id, event);
                          }}
                          onDoubleClick={() => beginEdit(row.id, columnIndex, cell)}
                          onContextMenu={(event) => openCellMenu(event, cellMenu(row, columnIndex))}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              className="taomni-input h-5 w-full text-[12px]"
                              value={editValue}
                              onChange={(event) => setEditValue(event.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") commitEdit();
                                if (event.key === "Escape") cancelEdit();
                              }}
                            />
                          ) : cell === null ? (
                            <span
                              className="text-[10px] px-1 rounded"
                              style={{ background: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                            >
                              NULL
                            </span>
                          ) : (
                            <span className={row.status === "deleted" ? "truncate line-through" : "truncate"}>{cell}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {viewMode === "list" && (
        <div
          className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-2 text-[12px]"
          tabIndex={0}
          onKeyDown={handleGridKeyDown}
        >
          {nonDeletedOrderedRows.map((row, rowIndex) => (
            <div
              key={row.id}
              className="mb-2 rounded p-2"
              style={{ border: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
            >
              <div className="mb-1 text-[11px] text-[var(--taomni-text-muted)]">Row {(row.originalIndex ?? rowIndex) + 1}</div>
              <div className="grid grid-cols-[minmax(90px,180px)_1fr] gap-x-3 gap-y-1">
                {visibleColumnIndexes.map((columnIndex) => (
                  <div key={columnIndex} className="contents">
                    <div className="truncate text-[var(--taomni-text-muted)]">{result.columns[columnIndex].name}</div>
                    <div
                      className="min-w-0 truncate rounded px-1 -mx-1 hover:bg-[var(--taomni-hover)]"
                      title={row.values[columnIndex] ?? "NULL"}
                      onClick={(event) => {
                        setCellBlockSelection(null);
                        setActiveCell({ rowId: row.id, colIdx: columnIndex });
                        selectRow(row.id, event);
                      }}
                      onDoubleClick={() => openCellValueViewer(row, columnIndex)}
                      onContextMenu={(event) => openCellMenu(event, cellMenu(row, columnIndex))}
                    >
                      {row.values[columnIndex] ?? <span className="text-[var(--taomni-text-muted)]">NULL</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === "chart" && (
        <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3 text-[12px]">
          {!chartData ? (
            <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
              No numeric column is available for chart view.
            </div>
          ) : (
            <div className="min-w-[420px]">
              <div className="mb-2 text-[11px] text-[var(--taomni-text-muted)]">
                {chartData.column.name} (first {chartData.points.length} rows)
              </div>
              <div className="space-y-1">
                {chartData.points.map((point, index) => (
                  <div key={`${point.label}-${index}`} className="grid grid-cols-[160px_1fr_72px] items-center gap-2">
                    <div className="truncate text-[var(--taomni-text-muted)]" title={point.label}>{point.label}</div>
                    <div className="h-4" style={{ background: "var(--taomni-divider)" }}>
                      <div
                        className="h-4"
                        style={{
                          width: `${Math.max(2, (Math.abs(point.value) / chartData.max) * 100)}%`,
                          background: point.value < 0 ? "#d9534f" : "var(--taomni-accent)",
                        }}
                      />
                    </div>
                    <div className="text-right font-mono">{point.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {exportDialogOpen && (
        <ExportDialog
          options={exportOptions}
          columns={exportColumns}
          target={exportTarget}
          rowCount={rowsForTarget(exportTarget).length}
          totalRows={nonDeletedOrderedRows.length}
          onOptionsChange={setExportOptions}
          onColumnsChange={setExportColumns}
          onClose={() => setExportDialogOpen(false)}
          onExport={(options, columns, destination) => {
            setExportOptions(options);
            setExportColumns(columns);
            setExportDialogOpen(false);
            void exportWithOptions(exportTarget, options, columns, destination);
          }}
        />
      )}
      {cellValueViewer && (
        <CellValueDialog
          viewer={cellValueViewer}
          onCopy={() => void copyCellViewerValue(cellValueViewer)}
          onClose={() => setCellValueViewer(null)}
        />
      )}
      {openColumnFilter && openFilterColumn && (
        <div
          ref={columnFilterPopoverRef}
          className="fixed z-[10000] w-[280px] rounded shadow-xl p-2 text-[12px]"
          style={{
            left: openColumnFilter.left,
            top: openColumnFilter.top,
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
            <div className="min-w-0 flex-1 truncate font-semibold" title={openFilterColumn.name}>
              {openFilterColumn.name}
            </div>
            <button
              type="button"
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
              title="Clear column filter"
              aria-label={`Clear filter for ${openFilterColumn.name}`}
              onClick={() => setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}
            >
              <Ban className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            type="search"
            autoFocus
            value={openFilterConfig.text}
            onChange={(event) => updateDraftColumnFilter({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyLocalColumnFilter();
              if (event.key === "Escape") setOpenColumnFilter(null);
            }}
            className="taomni-input h-7 w-full text-[12px]"
            placeholder="Filter this column"
            aria-label={`Filter ${openFilterColumn.name}`}
          />
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button
              type="button"
              className="taomni-btn h-7"
              style={filterModeButtonStyle(openFilterConfig.mode === "fuzzy")}
              onClick={() => updateDraftColumnFilter({ mode: "fuzzy" })}
            >
              Fuzzy
            </button>
            <button
              type="button"
              className="taomni-btn h-7"
              style={filterModeButtonStyle(openFilterConfig.mode === "exact")}
              onClick={() => updateDraftColumnFilter({ mode: "exact" })}
            >
              Exact
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-[var(--taomni-text-muted)]">
            <span>Distinct values</span>
            <span className="shrink-0">
              {openFilterConfig.selectedValues.length > 0
                ? `${openFilterConfig.selectedValues.length} selected`
                : `${openFilterDistinctValues.total} distinct`}
            </span>
          </div>
          <div
            className="mt-1 max-h-[154px] overflow-auto rounded taomni-scroll-y"
            style={{ border: "1px solid var(--taomni-divider)", background: "var(--taomni-bg)" }}
          >
            {openFilterDistinctValues.values.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                No values
              </div>
            ) : (
              openFilterDistinctValues.values.map((item) => (
                <label
                  key={item.key}
                  className="flex h-7 items-center gap-2 px-2 text-[11px] hover:bg-[var(--taomni-hover)]"
                  title={item.value === null ? "NULL" : item.value}
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 shrink-0"
                    checked={openFilterSelectedKeys.has(item.key)}
                    onChange={() => toggleDraftColumnFilterValue(item.value)}
                    aria-label={`Select ${item.label} for ${openFilterColumn.name}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{item.label}</span>
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">{item.count}</span>
                </label>
              ))
            )}
          </div>
          {openFilterDistinctValues.truncated && (
            <div className="mt-1 text-[10px] text-[var(--taomni-text-muted)]">
              Showing first {DISTINCT_FILTER_VALUE_LIMIT} values
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-1">
            <button type="button" className="taomni-btn h-7 px-2" onClick={() => setOpenColumnFilter(null)}>
              Close
            </button>
            <button type="button" className="taomni-btn h-7 px-2" onClick={() => setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}>
              Clear
            </button>
            <button type="button" className="taomni-btn h-7 px-2" onClick={applyLocalColumnFilter}>
              Apply
            </button>
          </div>
        </div>
      )}
      {menu}
    </div>
  );
}

export { type QueryRefreshMode, type QueryGeneratedSqlSyncMode, type QueryGridRowChange, type QueryGridCommitPayload } from "./grid/types";

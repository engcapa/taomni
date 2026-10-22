import {
  ArrowDown,
  ArrowUp,
  Ban,
  BarChart3,
  Check,
  ChevronDown,
  Columns2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Filter,
  List,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sigma,
  Table2,
  Trash2,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { type MenuItem } from "../../ContextMenu";
import { CellValueDialog } from "./CellValueDialog";
import { Divider, FragmentStats, StatsCell, ToolButton } from "./chrome";
import { nowDateText, nowTimestampText, nowTimeText } from "./export";
import { ExportDialog } from "./ExportDialog";
import { GridColumnFilterPopover } from "./GridColumnFilterPopover";
import { isColumnFilterActive, isNumeric, nextRowId, ROW_HEIGHT } from "./model";
import { DEFAULT_COLUMN_FILTER } from "./preferences";
import { type CellValueViewer, type GridRow, type ViewMode } from "./types";
import { useGridEditing } from "./useGridEditing";
import { useGridExport } from "./useGridExport";
import { useGridFilters } from "./useGridFilters";
import { useGridSelection } from "./useGridSelection";

export interface QueryResultGridViewProps {
  running: boolean;
  onRefresh: ((mode: import("./types").QueryRefreshMode) => void) | undefined;
  openDropdown: (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => void;
  cancelling: boolean;
  onCancel: (() => void) | undefined;
  exporter: ReturnType<typeof useGridExport>;
  selection: ReturnType<typeof useGridSelection>;
  columnMenu: () => MenuItem[];
  autoFit: boolean;
  setAutoFit: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setShowStats: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showStats: boolean;
  filters: ReturnType<typeof useGridFilters>;
  editSession: ReturnType<typeof useGridEditing>;
  pendingChangeCount: number;
  searchText: string;
  setSearchText: import("react").Dispatch<import("react").SetStateAction<string>>;
  searchMatchCount: number;
  viewMode: ViewMode;
  setViewMode: import("react").Dispatch<import("react").SetStateAction<ViewMode>>;
  rows: GridRow[];
  visibleColumnIndexes: number[];
  localNotice: string;
  changeCounts: { inserted: number; updated: number; deleted: number; };
  generatedSql: string | null;
  displayGeneratedSqlTitle: string | null;
  generatedSqlBarText: string;
  generatedSqlActionsDisabled: boolean;
  queryGeneratedSql: (sql?: string | null, request?: import("../../../lib/ipc").DbResultSqlRewriteRequest | null) => void;
  copyGeneratedSql: () => Promise<void>;
  syncGeneratedSql: (mode: import("./types").QueryGeneratedSqlSyncMode, sql?: string | null, request?: import("../../../lib/ipc").DbResultSqlRewriteRequest | null) => Promise<void>;
  stats: { column: import("../../../lib/ipc").DbColumn; count: number; nulls: number; distinct: number; min: string | number; max: string | number; avg: number | null; }[];
  scrollLeft: number;
  result: import("../../../lib/ipc").DbQueryResult;
  columnStyle: (columnIndex: number) => CSSProperties;
  startColumnResize: (event: MouseEvent<HTMLElement>, columnIndex: number) => void;
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  handleGridKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  total: number;
  visible: number[];
  startRow: number;
  searchNeedle: string;
  openCellMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  cellMenu: (row: GridRow, colIdx: number) => MenuItem[];
  nonDeletedOrderedRows: GridRow[];
  openCellValueViewer: (row: GridRow, colIdx: number) => boolean;
  chartData: { column: import("../../../lib/ipc").DbColumn; points: { label: string; value: number; }[]; max: number; } | null;
  cellValueViewer: CellValueViewer | null;
  copyCellViewerValue: (viewer: CellValueViewer) => Promise<void>;
  setCellValueViewer: import("react").Dispatch<import("react").SetStateAction<CellValueViewer | null>>;
  menu: import("react").JSX.Element | null;
}

export function QueryResultGridView(inputs: QueryResultGridViewProps) {
  const {
    running,
    onRefresh,
    openDropdown,
    cancelling,
    onCancel,
    exporter,
    selection,
    columnMenu,
    autoFit,
    setAutoFit,
    setShowStats,
    showStats,
    filters,
    editSession,
    pendingChangeCount,
    searchText,
    setSearchText,
    searchMatchCount,
    viewMode,
    setViewMode,
    rows,
    visibleColumnIndexes,
    localNotice,
    changeCounts,
    generatedSql,
    displayGeneratedSqlTitle,
    generatedSqlBarText,
    generatedSqlActionsDisabled,
    queryGeneratedSql,
    copyGeneratedSql,
    syncGeneratedSql,
    stats,
    scrollLeft,
    result,
    columnStyle,
    startColumnResize,
    containerRef,
    onScroll,
    handleGridKeyDown,
    total,
    visible,
    startRow,
    searchNeedle,
    openCellMenu,
    cellMenu,
    nonDeletedOrderedRows,
    openCellValueViewer,
    chartData,
    cellValueViewer,
    copyCellViewerValue,
    setCellValueViewer,
    menu,
  } = inputs;
  return ((
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
                  exporter.setExportTarget("all");
                  exporter.setExportDialogOpen(true);
                },
              },
              {
                label: "Export Selection...",
                icon: <Download className="w-3.5 h-3.5" />,
                disabled: selection.selectionRowCount === 0,
                onClick: () => {
                  exporter.setExportTarget("selection");
                  exporter.setExportDialogOpen(true);
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
                onClick: () => exporter.openSpreadsheet("all"),
              },
              {
                label: "Open Selection as Spreadsheet...",
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                disabled: selection.selectionRowCount === 0,
                onClick: () => exporter.openSpreadsheet("selection"),
              },
              { separator: true, label: "open-separator" },
              {
                label: "Open in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                onClick: () => exporter.openBrowser("all"),
              },
              {
                label: "Open Selection in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                disabled: selection.selectionRowCount === 0,
                onClick: () => exporter.openBrowser("selection"),
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
          onClick={() => filters.setFilterOpen((value) => !value)}
          active={filters.filterOpen || !!filters.filterText.trim() || filters.activeColumnFilterCount > 0}
          icon={<Filter className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Copy result"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Copy Results", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => void exporter.copyRows("all") },
              {
                label: "Copy Selection",
                icon: <Copy className="w-3.5 h-3.5" />,
                disabled: selection.selectionRowCount === 0,
                onClick: () => void exporter.copyRows("selection"),
              },
            ])
          }
          icon={<Copy className="w-3.5 h-3.5" />}
        />
        <Divider />
        <ToolButton title="Add row" onClick={editSession.addRow} icon={<Plus className="w-3.5 h-3.5" />} />
        <ToolButton title="Duplicate row" onClick={editSession.duplicateRows} icon={<Copy className="w-3.5 h-3.5" />} />
        <ToolButton title="Delete row" onClick={editSession.deleteRows} icon={<Trash2 className="w-3.5 h-3.5" />} />
        <ToolButton
          title="Set value"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Set to Current Date (yyyy-MM-dd)", onClick: () => editSession.applyValueToTargets(nowDateText) },
              { label: "Set to Current Time (HH:mm:ss)", onClick: () => editSession.applyValueToTargets(nowTimeText) },
              { label: "Set to Current Timestamp (yyyy-MM-dd HH:mm:ss)", onClick: () => editSession.applyValueToTargets(nowTimestampText) },
              { label: "Set to UUID (36 chars)", onClick: () => editSession.applyValueToTargets(() => crypto.randomUUID?.() ?? nextRowId("uuid")) },
              { label: "Set to Empty String", onClick: () => editSession.applyValueToTargets(() => "") },
              { label: 'Set to NULL "(null)"', onClick: () => editSession.applyValueToTargets(() => null) },
            ])
          }
          icon={<Edit3 className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <ToolButton
          title="Submit grid edits"
          disabled={pendingChangeCount === 0 || editSession.submittingChanges}
          onClick={() => void editSession.submitChanges()}
          icon={editSession.submittingChanges ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Undo unsubmitted edits"
          disabled={pendingChangeCount === 0}
          onClick={editSession.undoChanges}
          icon={<RotateCcw className="w-3.5 h-3.5" />}
        />
        <Divider />
        {filters.filterOpen && (
          <label className="h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
            <Filter className="w-3.5 h-3.5" />
            <input
              type="search"
              value={filters.filterText}
              onChange={(event) => filters.setFilterText(event.target.value)}
              className="taomni-input h-6 w-[150px] text-[11px]"
              placeholder="Filter rows"
              aria-label="Filter rows"
            />
          </label>
        )}
        {(filters.filterText.trim() || filters.activeColumnFilterCount > 0) && (
          <button
            type="button"
            className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            title="Clear filters"
            onClick={filters.clearAllFilters}
          >
            <Ban className="w-3.5 h-3.5" />
            {filters.activeColumnFilterCount > 0 ? `${filters.activeColumnFilterCount} col` : "Clear"}
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
          data-filtered={filters.rowsFiltered ? "true" : "false"}
          className="px-1 text-[10px] tabular-nums text-[var(--taomni-text-muted)]"
          title={filters.rowsFiltered ? "Rows shown [total rows] / columns" : "Rows / columns"}
        >
          {filters.rowsFiltered ? `${filters.orderedRows.length} [${rows.length}]` : rows.length}/{visibleColumnIndexes.length}
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
                <span className="text-[10px]">{selection.selectionRowCount || ""}</span>
              </div>
              {visibleColumnIndexes.map((columnIndex) => {
                const col = result.columns[columnIndex];
                const columnFilter = filters.columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
                const columnFiltered = isColumnFilterActive(columnFilter);
                const sortIndex = filters.sorts.findIndex((sort) => sort.columnIndex === columnIndex);
                const columnSort = sortIndex >= 0 ? filters.sorts[sortIndex] : null;
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
                      onClick={(event) => filters.toggleSort(columnIndex, event.shiftKey)}
                    >
                      <span className="truncate flex-1">{col.name}</span>
                      {columnSort?.dir === "asc" && <ArrowUp className="w-3 h-3" />}
                      {columnSort?.dir === "desc" && <ArrowDown className="w-3 h-3" />}
                      {filters.sorts.length > 1 && sortIndex >= 0 && (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[9px] text-[var(--taomni-accent)]" style={{ background: "var(--taomni-selected)" }}>
                          {sortIndex + 1}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={`mr-1 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded transition-all hover:bg-[var(--taomni-hover)] ${columnFiltered
                        ? "opacity-100 text-[var(--taomni-accent)] shadow-sm"
                        : "opacity-0 translate-y-0.5 text-[var(--taomni-text-muted)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
                        }`}
                      style={columnFiltered ? { background: "var(--taomni-selected)" } : undefined}
                      title={`Filter ${col.name}`}
                      aria-label={`Filter column ${col.name}`}
                      onClick={(event) => filters.openColumnFilterPanel(event, columnIndex)}
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
                const selected = selection.selectedIds.has(row.id);
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
                      onClick={(event) => selection.selectRow(row.id, event)}
                      title={row.status === "clean" ? `Row ${(row.originalIndex ?? rowIndex) + 1}` : row.status}
                    >
                      <span className="mr-1 text-[10px]">
                        {row.status === "inserted" ? "+" : row.status === "updated" ? "~" : row.status === "deleted" ? "-" : ""}
                      </span>
                      {(row.originalIndex ?? rowIndex) + 1}
                    </button>
                    {visibleColumnIndexes.map((columnIndex) => {
                      const cell = row.values[columnIndex];
                      const active = selection.activeCell?.rowId === row.id && selection.activeCell.colIdx === columnIndex;
                      const editing = editSession.editingCell?.rowId === row.id && editSession.editingCell.colIdx === columnIndex;
                      const searchHit = !!searchNeedle && (cell ?? "").toLowerCase().includes(searchNeedle);
                      const blockSelected = !!selection.cellBlockRange?.rowIds.has(row.id) && selection.cellBlockRange.colIdxSet.has(columnIndex);
                      return (
                        <div
                          key={columnIndex}
                          className={`px-2 flex items-center truncate ${isNumeric(cell) ? "justify-end font-mono" : ""
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
                          onMouseDown={(event) => selection.startCellBlockSelection(event, row.id, columnIndex)}
                          onMouseEnter={() => selection.extendCellBlockSelection(row.id, columnIndex)}
                          onClick={(event) => {
                            if (event.altKey) return;
                            selection.setCellBlockSelection(null);
                            selection.setActiveCell({ rowId: row.id, colIdx: columnIndex });
                            selection.selectRow(row.id, event);
                          }}
                          onDoubleClick={() => editSession.beginEdit(row.id, columnIndex, cell)}
                          onContextMenu={(event) => openCellMenu(event, cellMenu(row, columnIndex))}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              className="taomni-input h-5 w-full text-[12px]"
                              value={editSession.editValue}
                              onChange={(event) => editSession.setEditValue(event.target.value)}
                              onBlur={editSession.commitEdit}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") editSession.commitEdit();
                                if (event.key === "Escape") editSession.cancelEdit();
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
                        selection.setCellBlockSelection(null);
                        selection.setActiveCell({ rowId: row.id, colIdx: columnIndex });
                        selection.selectRow(row.id, event);
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

      {exporter.exportDialogOpen && (
        <ExportDialog
          options={exporter.exportOptions}
          columns={exporter.exportColumns}
          target={exporter.exportTarget}
          rowCount={exporter.rowsForTarget(exporter.exportTarget).length}
          totalRows={nonDeletedOrderedRows.length}
          onOptionsChange={exporter.setExportOptions}
          onColumnsChange={exporter.setExportColumns}
          onClose={() => exporter.setExportDialogOpen(false)}
          onExport={(options, columns, destination) => {
            exporter.setExportOptions(options);
            exporter.setExportColumns(columns);
            exporter.setExportDialogOpen(false);
            void exporter.exportWithOptions(exporter.exportTarget, options, columns, destination);
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
      {<GridColumnFilterPopover filters={filters} />}
      {menu}
    </div>
  ));
}

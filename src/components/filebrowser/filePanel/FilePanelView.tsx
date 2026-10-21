import { AlertTriangle, Eye, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { formatBytes, type FileEntry } from "../../../lib/sftp";
import { WINDOWS_DRIVES_ROOT } from "../../../stores/sftpStore";
import { useContextMenu } from "../../ContextMenu";
import { FileToolbar } from "../FileToolbar";
import { PathBreadcrumb } from "../PathBreadcrumb";
import { DrivesPicker, FileTypeIcon, SortHeader } from "./Controls";
import { createFilePanelInteractions } from "./createFilePanelInteractions";
import { useFilePanelColumns } from "./useFilePanelColumns";

export interface FilePanelViewProps {
  side: import("../../../stores/sftpStore").PaneSide;
  subtitle: string | undefined;
  onFilterTextChange: ((next: string) => void) | undefined;
  filterText: string | undefined;
  t: ReturnType<typeof useT>;
  onUploadFromDisk: ((files: File[]) => void) | undefined;
  fileInputRef: import("react").RefObject<HTMLInputElement | null>;
  pane: import("../../../stores/sftpStore").PaneState;
  showHidden: boolean;
  selectedEntries: FileEntry[];
  canPreview: boolean;
  navigateBack: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide) => Promise<void>;
  sessionId: string;
  navigateForward: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide) => Promise<void>;
  refresh: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide) => Promise<void>;
  handleMkdir: () => void;
  onNewFile: (() => void) | undefined;
  onDeleteSelected: ((entries: FileEntry[]) => void) | undefined;
  onChmodSelected: ((entries: FileEntry[]) => void) | undefined;
  onPreviewSelected: ((entry: FileEntry) => void) | undefined;
  firstSelected: FileEntry;
  onDownloadSelected: ((entries: FileEntry[]) => void) | undefined;
  onUploadSelected: ((entries: FileEntry[]) => void) | undefined;
  onOpenLocalSelected: ((entries: FileEntry[]) => void) | undefined;
  onRevealInOs: ((path: string) => void) | undefined;
  onOpenTerminalHere: ((path: string) => void) | undefined;
  toggleHidden: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide) => void;
  detachable: boolean | undefined;
  onDetach: (() => void) | undefined;
  showDrivesPicker: boolean;
  navigate: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide, path: string) => Promise<void>;
  session: import("../../../stores/sftpStore").FilePanelSession;
  submitAddress: (value: string) => Promise<void>;
  listDirectory: (directory: string) => Promise<FileEntry[]>;
  hasListingStatus: boolean;
  skippedEntryCount: number;
  diagnosticTitle: string;
  hiddenBySettingCount: number;
  filterActive: boolean;
  sortedEntries: FileEntry[];
  filterCandidateCount: number;
  normalizedFilter: string;
  listRef: import("react").RefObject<HTMLDivElement | null>;
  interactions: ReturnType<typeof createFilePanelInteractions>;
  ctx: ReturnType<typeof useContextMenu>;
  draggingOver: boolean;
  columns: ReturnType<typeof useFilePanelColumns>;
  sortKey: "type" | "name" | "size" | "mtime";
  sortDir: "asc" | "desc";
  onHeaderClick: (key: "type" | "name" | "size" | "mtime") => void;
  onItemDoubleClick: (entry: FileEntry) => void;
}

export function FilePanelView(inputs: FilePanelViewProps) {
  const {
    side,
    subtitle,
    onFilterTextChange,
    filterText,
    t,
    onUploadFromDisk,
    fileInputRef,
    pane,
    showHidden,
    selectedEntries,
    canPreview,
    navigateBack,
    sessionId,
    navigateForward,
    navigateUp,
    refresh,
    handleMkdir,
    onNewFile,
    onDeleteSelected,
    onChmodSelected,
    onPreviewSelected,
    firstSelected,
    onDownloadSelected,
    onUploadSelected,
    onOpenLocalSelected,
    onRevealInOs,
    onOpenTerminalHere,
    toggleHidden,
    detachable,
    onDetach,
    showDrivesPicker,
    navigate,
    session,
    submitAddress,
    listDirectory,
    hasListingStatus,
    skippedEntryCount,
    diagnosticTitle,
    hiddenBySettingCount,
    filterActive,
    sortedEntries,
    filterCandidateCount,
    normalizedFilter,
    listRef,
    interactions,
    ctx,
    draggingOver,
    columns,
    sortKey,
    sortDir,
    onHeaderClick,
    onItemDoubleClick,
  } = inputs;
  return ((
    <div data-testid={`sftp-${side}-pane`} className="h-full w-full min-w-0 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center px-2 text-[11px] border-b shrink-0 gap-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span
          className="px-1.5 py-[1px] text-[10px] font-bold tracking-wider rounded shrink-0"
          style={{
            background: side === "remote" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
            color: "#fff",
            letterSpacing: "0.08em",
          }}
        >
          {side === "remote" ? "REMOTE" : "LOCAL"}
        </span>
        {subtitle && (
          <span
            className="truncate text-[11px]"
            style={{ color: "var(--taomni-text-muted)" }}
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
        <div className="flex-1" />
        {onFilterTextChange && (
          <input
            type="search"
            data-testid={`sftp-${side}-filter`}
            value={filterText ?? ""}
            placeholder={t("fileBrowser.filterPlaceholder")}
            onChange={(e) => onFilterTextChange(e.target.value)}
            className="taomni-input h-5 px-1.5 text-[11px] w-[140px] rounded shrink-0"
            style={{
              background: "var(--taomni-input-bg)",
              border: "1px solid var(--taomni-input-border)",
              color: "var(--taomni-text)",
            }}
          />
        )}
      </div>
      {onUploadFromDisk && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onUploadFromDisk(files);
            e.target.value = "";
          }}
        />
      )}
      <FileToolbar
        side={side}
        canBack={pane.historyIndex > 0}
        canForward={pane.historyIndex < pane.history.length - 1}
        canUp={
          !!pane.path &&
          pane.path !== "/" &&
          pane.path !== WINDOWS_DRIVES_ROOT
        }
        showHidden={showHidden}
        loading={pane.loading}
        selectionCount={selectedEntries.length}
        canPreview={canPreview}
        onBack={() => void navigateBack(sessionId, side)}
        onForward={() => void navigateForward(sessionId, side)}
        onUp={() => void navigateUp(sessionId, side)}
        onRefresh={() => void refresh(sessionId, side)}
        onMkdir={handleMkdir}
        onNewFile={onNewFile}
        onDelete={
          onDeleteSelected
            ? () => {
              if (selectedEntries.length === 0) return;
              onDeleteSelected(selectedEntries);
            }
            : undefined
        }
        onChmod={
          onChmodSelected && selectedEntries.length > 0
            ? () => onChmodSelected(selectedEntries)
            : undefined
        }
        onPreview={
          onPreviewSelected && firstSelected
            ? () => onPreviewSelected(firstSelected)
            : undefined
        }
        onDownloadSelected={
          side === "remote" && onDownloadSelected
            ? () => {
              if (selectedEntries.length === 0) return;
              onDownloadSelected(selectedEntries);
            }
            : undefined
        }
        onUploadSelected={
          side === "local" && onUploadSelected
            ? () => {
              if (selectedEntries.length === 0) return;
              onUploadSelected(selectedEntries);
            }
            : undefined
        }
        onUploadFromDisk={
          side === "remote" && onUploadFromDisk
            ? () => fileInputRef.current?.click()
            : undefined
        }
        onOpenLocalSelected={
          side === "local" && onOpenLocalSelected && selectedEntries.length > 0
            ? () => onOpenLocalSelected(selectedEntries)
            : undefined
        }
        onRevealInOs={
          side === "local" && onRevealInOs && pane.path
            ? () => onRevealInOs(pane.path)
            : undefined
        }
        onOpenTerminalHere={
          side === "remote" && onOpenTerminalHere
            ? () => onOpenTerminalHere(pane.path)
            : undefined
        }
        onToggleHidden={() => toggleHidden(sessionId, side)}
        onDetach={detachable ? onDetach : undefined}
      />
      <div className="h-6 min-h-[24px] flex items-center gap-1 px-1 border-b shrink-0"
        style={{ borderColor: "var(--taomni-divider)" }}>
        {showDrivesPicker && (
          <DrivesPicker
            onSelect={(p) => void navigate(sessionId, side, p)}
          />
        )}
        <PathBreadcrumb
          testId={`sftp-${side}-path`}
          path={pane.path}
          homePath={side === "remote" ? session?.homeDir ?? null : null}
          onNavigate={(p) => void navigate(sessionId, side, p)}
          onSubmit={(p) => void submitAddress(p)}
          detectWindows={side === "remote" ? false : undefined}
          listDirectory={listDirectory}
          showHidden={showHidden}
        />
      </div>

      {!pane.error && hasListingStatus && (
        <div
          data-testid={`sftp-${side}-listing-status`}
          role="status"
          className="min-h-6 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b shrink-0 text-[11px]"
          style={{
            borderColor: "var(--taomni-divider)",
            background: "var(--taomni-quick-bg)",
            color: "var(--taomni-text-muted)",
          }}
        >
          {skippedEntryCount > 0 && (
            <span
              data-testid={`sftp-${side}-access-warning`}
              className="inline-flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-400"
              title={diagnosticTitle || undefined}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{t("fileBrowser.unreadableItemsSummary", { count: skippedEntryCount })}</span>
            </span>
          )}
          {hiddenBySettingCount > 0 && (
            <button
              type="button"
              data-testid={`sftp-${side}-show-hidden-filtered`}
              className="inline-flex items-center gap-1 hover:text-[var(--taomni-text)]"
              title={t("fileBrowser.showHidden")}
              onClick={() => toggleHidden(sessionId, side)}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>{t("fileBrowser.hiddenItemsSummary", { count: hiddenBySettingCount })}</span>
            </button>
          )}
          {filterActive && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate">
                {t("fileBrowser.filterSummary", {
                  shown: sortedEntries.length,
                  total: filterCandidateCount,
                  query: normalizedFilter,
                })}
              </span>
              <button
                type="button"
                data-testid={`sftp-${side}-clear-filter`}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center hover:text-[var(--taomni-text)]"
                title={t("fileBrowser.clearFilter")}
                onClick={() => onFilterTextChange?.("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      )}

      <div
        ref={listRef}
        data-testid={`sftp-${side}-list`}
        className="flex-1 overflow-auto text-[12px] relative"
        onDragOver={interactions.handleDragOver}
        onDragLeave={interactions.handleDragLeave}
        onDrop={interactions.handleDrop}
        onContextMenu={interactions.handleEmptyContext}
        onClick={interactions.handleEmptyClick}
        style={{ background: "var(--taomni-bg)" }}
      >
        {ctx.render}
        {draggingOver && (
          <div
            className="absolute inset-0 pointer-events-none border-2 border-dashed z-10 flex items-center justify-center"
            style={{ borderColor: "var(--taomni-accent)", background: "rgba(43,93,139,0.08)" }}
          >
            <span className="text-xs font-semibold text-[var(--taomni-accent)]">
              {t("fileBrowser.dropToCopy")}
            </span>
          </div>
        )}
        <table
          className="border-collapse"
          // Use max(100%, sumOfWidths) so the table always fills the
          // pane horizontally but can also exceed it (with horizontal
          // scroll on the wrapper) when the user enlarges columns.
          style={{
            tableLayout: "fixed",
            width: `max(100%, ${columns.colWidths.name + columns.colWidths.size + columns.colWidths.mtime + columns.colWidths.type
              }px)`,
          }}
        >
          <colgroup>
            <col style={{ width: columns.colWidths.name }} />
            <col style={{ width: columns.colWidths.size }} />
            <col style={{ width: columns.colWidths.mtime }} />
            <col style={{ width: columns.colWidths.type }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ background: "var(--taomni-quick-bg)" }}>
            <tr className="text-[11px] uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
              <SortHeader
                label={t("fileBrowser.sortName")}
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => onHeaderClick("name")}
                onResizeStart={(e) => columns.startColResize("name", e)}
                onResizeReset={() => columns.resetCol("name")}
                hint={t("fileBrowser.sortNameHint")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="name"
              />
              <SortHeader
                label={t("fileBrowser.sortSize")}
                active={sortKey === "size"}
                dir={sortDir}
                onClick={() => onHeaderClick("size")}
                className="text-right"
                onResizeStart={(e) => columns.startColResize("size", e)}
                onResizeReset={() => columns.resetCol("size")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="size"
              />
              <SortHeader
                label={t("fileBrowser.sortModified")}
                active={sortKey === "mtime"}
                dir={sortDir}
                onClick={() => onHeaderClick("mtime")}
                onResizeStart={(e) => columns.startColResize("mtime", e)}
                onResizeReset={() => columns.resetCol("mtime")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="modified"
              />
              <SortHeader
                label={t("fileBrowser.sortType")}
                active={sortKey === "type"}
                dir={sortDir}
                onClick={() => onHeaderClick("type")}
                onResizeStart={(e) => columns.startColResize("type", e)}
                onResizeReset={() => columns.resetCol("type")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="type"
              />
            </tr>
          </thead>
          <tbody>
            {pane.error && (
              <tr>
                <td colSpan={4} className="px-2 py-2 text-red-500 text-[11px]">
                  {pane.error}
                </td>
              </tr>
            )}
            {sortedEntries.length === 0 && !pane.loading && !pane.error && (
              <tr>
                <td colSpan={4} className="px-2 py-3 text-center text-[var(--taomni-text-muted)]">
                  {pane.entries.length === 0 && skippedEntryCount > 0
                    ? t("fileBrowser.noReadableEntries")
                    : filterActive
                      ? t("fileBrowser.noFilterMatches", { query: normalizedFilter })
                      : hiddenBySettingCount > 0
                        ? t("fileBrowser.hiddenItemsNotShown", { count: hiddenBySettingCount })
                        : t("fileBrowser.emptyDirectory")}
                </td>
              </tr>
            )}
            {sortedEntries.map((entry) => (
              <tr
                key={entry.path}
                data-row
                onPointerDown={(e) => interactions.handleRowPointerDown(entry, e)}
                className="cursor-default select-none"
                style={{
                  background: pane.selection.includes(entry.path)
                    ? "var(--taomni-selected)"
                    : undefined,
                }}
                onClick={(e) => interactions.handleRowClick(entry, e)}
                onDoubleClick={() => onItemDoubleClick(entry)}
                onContextMenu={(e) => interactions.handleRowContext(entry, e)}
                title={entry.path}
              >
                <td className="px-1.5 py-0.5 truncate">
                  <div className="flex items-center gap-1 min-w-0">
                    <FileTypeIcon entry={entry} />
                    <span className="truncate">{entry.name}</span>
                    {entry.symlinkTarget && (
                      <span className="truncate text-[10px] text-[var(--taomni-text-muted)]">→ {entry.symlinkTarget}</span>
                    )}
                  </div>
                </td>
                <td className="px-1.5 py-0.5 text-right text-[var(--taomni-text-muted)] truncate">
                  {entry.fileType === "dir" ? "" : formatBytes(entry.size)}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--taomni-text-muted)] truncate">
                  {entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : ""}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--taomni-text-muted)] truncate">
                  {entry.fileType === "dir"
                    ? t("fileBrowser.typeFolder")
                    : (entry.name.split(".").pop() ?? "").toLowerCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="h-5 px-2 text-[11px] flex items-center border-t shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-status-bg)", color: "var(--taomni-status-text)" }}>
        {pane.loading
          ? t("fileBrowser.statusLoading")
          : pane.selection.length > 0
            ? t("fileBrowser.statusItemsCountSelected", {
              count: sortedEntries.length,
              plural: sortedEntries.length === 1 ? "" : "s",
              selected: pane.selection.length,
            })
            : t("fileBrowser.statusItemsCount", {
              count: sortedEntries.length,
              plural: sortedEntries.length === 1 ? "" : "s",
            })}
      </div>
    </div>
  ));
}

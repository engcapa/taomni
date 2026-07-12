import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  File,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Info,
  List,
  ListTree,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LspDocumentStatus, LspServerStatus } from "../../../lib/editor/lsp";

export type FileTreeViewMode = "tree" | "compact" | "flat";

export interface LspCustomCommandConfig {
  command: string;
  args: string;
}

interface FileTreePaneProps {
  paneRef: RefObject<HTMLElement | null>;
  style: CSSProperties;
  filter: string;
  onFilterChange: (value: string) => void;
  viewMode: FileTreeViewMode;
  onViewModeChange: (mode: FileTreeViewMode) => void;
  fontSize: number;
  minFontSize: number;
  maxFontSize: number;
  defaultFontSize: number;
  onFontSizeChange: (size: number) => void;
  onOpenFile: () => void;
  onAddFolder: () => void;
  canCreate: boolean;
  canMutateSelection: boolean;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onRename: () => void;
  onDelete: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
  languageServers: {
    open: boolean;
    statuses: LspServerStatus[];
    activeStatus: LspDocumentStatus | null;
    commandPrefs: Record<string, string>;
    customCommands: Record<string, LspCustomCommandConfig>;
    customCommandId: string;
    formatOnSave: boolean;
    onToggle: () => void;
    onRefresh: () => void;
    onFormatOnSaveChange: (enabled: boolean) => void;
    onCommandChange: (presetId: string, commandId: string) => void;
    onCustomCommandChange: (presetId: string, patch: Partial<LspCustomCommandConfig>) => void;
  };
}

interface TreeIconButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
}

function TreeIconButton({
  label,
  icon,
  onClick,
  testId,
  active = false,
  disabled = false,
}: TreeIconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)] disabled:opacity-40"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function FileTreePane({
  paneRef,
  style,
  filter,
  onFilterChange,
  viewMode,
  onViewModeChange,
  fontSize,
  minFontSize,
  maxFontSize,
  defaultFontSize,
  onFontSizeChange,
  onOpenFile,
  onAddFolder,
  canCreate,
  canMutateSelection,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onDelete,
  children,
  languageServers,
  onKeyDown,
}: FileTreePaneProps) {
  return (
    <aside
      ref={paneRef}
      tabIndex={0}
      data-testid="code-workspace-tree-pane"
      className="h-full min-h-0 flex flex-col border-r border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--taomni-accent)]"
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="h-9 shrink-0 flex items-center gap-2 overflow-x-auto px-2 border-b border-[var(--taomni-code-border)]">
        <Search className="w-3.5 h-3.5 text-[var(--taomni-code-muted)]" />
        <input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="Filter"
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-transparent outline-none text-[var(--taomni-code-text)] placeholder:text-[var(--taomni-code-muted)]"
          style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
        />
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
          <TreeIconButton
            label="Tree view"
            testId="code-workspace-view-tree"
            icon={<ListTree className="w-3.5 h-3.5" />}
            active={viewMode === "tree"}
            onClick={() => onViewModeChange("tree")}
          />
          <TreeIconButton
            label="Compact tree view"
            testId="code-workspace-view-compact"
            icon={<Columns2 className="w-3.5 h-3.5" />}
            active={viewMode === "compact"}
            onClick={() => onViewModeChange("compact")}
          />
          <TreeIconButton
            label="Flat file view"
            testId="code-workspace-view-flat"
            icon={<List className="w-3.5 h-3.5" />}
            active={viewMode === "flat"}
            onClick={() => onViewModeChange("flat")}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
          <TreeIconButton
            label="Tree zoom out"
            testId="code-workspace-tree-zoom-out"
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            disabled={fontSize <= minFontSize}
            onClick={() => onFontSizeChange(fontSize - 1)}
          />
          <button
            type="button"
            data-testid="code-workspace-tree-zoom-reset"
            title="Reset tree zoom"
            aria-label="Reset tree zoom"
            className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => onFontSizeChange(defaultFontSize)}
          >
            {fontSize}px
          </button>
          <TreeIconButton
            label="Tree zoom in"
            testId="code-workspace-tree-zoom-in"
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            disabled={fontSize >= maxFontSize}
            onClick={() => onFontSizeChange(fontSize + 1)}
          />
        </div>
        <TreeIconButton label="Open file" icon={<File className="w-3.5 h-3.5" />} onClick={onOpenFile} />
        <TreeIconButton label="Add folder" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={onAddFolder} />
        <TreeIconButton label="New file" icon={<FilePlus className="w-3.5 h-3.5" />} disabled={!canCreate} onClick={onCreateFile} />
        <TreeIconButton label="New directory" icon={<FolderPlus className="w-3.5 h-3.5" />} disabled={!canCreate} onClick={onCreateDirectory} />
        <TreeIconButton label="Rename" icon={<Pencil className="w-3.5 h-3.5" />} disabled={!canMutateSelection} onClick={onRename} />
        <TreeIconButton label="Delete or remove" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={!canMutateSelection} onClick={onDelete} />
      </div>
      <div
        data-testid="code-workspace-tree"
        className="flex-1 min-h-0 overflow-auto py-1"
        style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
      >
        {children}
      </div>
      <LanguageServersPanel {...languageServers} />
    </aside>
  );
}

function LanguageServersPanel({
  open,
  statuses,
  activeStatus,
  commandPrefs,
  customCommands,
  customCommandId,
  formatOnSave,
  onToggle,
  onRefresh,
  onFormatOnSaveChange,
  onCommandChange,
  onCustomCommandChange,
}: FileTreePaneProps["languageServers"]) {
  const missingCount = statuses.filter((status) => !status.available).length;
  return (
    <section className="shrink-0 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
      <div className="h-7 flex items-center text-[11px] font-semibold">
        <button
          type="button"
          data-testid="code-workspace-language-servers-toggle"
          className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onToggle}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Server className="w-3.5 h-3.5 text-[var(--taomni-code-muted)]" />
          <span className="min-w-0 flex-1 truncate">Language Servers</span>
          {missingCount > 0 && (
            <span className="shrink-0 text-[10px] text-amber-500">{missingCount} missing</span>
          )}
        </button>
        <button
          type="button"
          title="Refresh language servers"
          aria-label="Refresh language servers"
          className="mr-1 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onRefresh}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <div className="max-h-56 overflow-auto pb-1">
          <label className="flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-2 py-1.5 text-[11px]">
            <input
              type="checkbox"
              data-testid="code-workspace-format-on-save"
              aria-label="Format on save"
              checked={formatOnSave}
              onChange={(event) => onFormatOnSaveChange(event.target.checked)}
            />
            <span className="min-w-0 flex-1">Format on save</span>
            <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">Workspace</span>
          </label>
          {activeStatus && (
            <div className="px-2 py-1 border-b border-[var(--taomni-code-border)] text-[11px]">
              <div className="flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  Active: {activeStatus.displayName ?? "None"}
                </span>
              </div>
              {!activeStatus.active && activeStatus.installHint && (
                <div className="mt-1 truncate font-mono text-[10px] text-amber-500" title={activeStatus.installHint}>
                  {activeStatus.installHint}
                </div>
              )}
            </div>
          )}
          {statuses.map((status) => {
            const custom = customCommands[status.presetId] ?? { command: "", args: "" };
            const selected = commandPrefs[status.presetId] ?? status.selectedCommandId ?? status.commands[0]?.id ?? "";
            return (
              <div key={status.presetId} className="px-2 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span
                    data-available={status.available || undefined}
                    className="h-2 w-2 shrink-0 rounded-full bg-amber-500 data-[available=true]:bg-[var(--taomni-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{status.displayName}</span>
                  {status.active && <span className="shrink-0 text-[10px] text-[var(--taomni-accent)]">active</span>}
                </div>
                <select
                  value={selected}
                  className="mt-1 h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[11px] text-[var(--taomni-code-text)] outline-none"
                  onChange={(event) => onCommandChange(status.presetId, event.target.value)}
                  aria-label={`${status.displayName} language server command`}
                >
                  {status.commands.map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.label}{command.fallback ? " fallback" : ""}
                    </option>
                  ))}
                  <option value={customCommandId}>Custom command</option>
                </select>
                {selected === customCommandId && (
                  <div className="mt-1 grid grid-cols-1 gap-1">
                    <input
                      value={custom.command}
                      className="h-6 min-w-0 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 font-mono text-[11px] text-[var(--taomni-code-text)] outline-none"
                      placeholder="Command or absolute path"
                      aria-label={`${status.displayName} custom command`}
                      onChange={(event) => onCustomCommandChange(status.presetId, { command: event.target.value })}
                    />
                    <input
                      value={custom.args}
                      className="h-6 min-w-0 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 font-mono text-[11px] text-[var(--taomni-code-text)] outline-none"
                      placeholder="Args"
                      aria-label={`${status.displayName} custom args`}
                      onChange={(event) => onCustomCommandChange(status.presetId, { args: event.target.value })}
                    />
                  </div>
                )}
                {!status.available && (
                  <div className="mt-1 truncate font-mono text-[10px] text-amber-500" title={status.installHint}>
                    {status.installHint}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

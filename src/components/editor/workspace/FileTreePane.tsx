import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  File,
  FolderOpen,
  LocateFixed,
  Minus,
  MoreVertical,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useContextMenu, type MenuItem } from "../../ContextMenu";
import {
  treeToolbarDensity,
  treeToolbarVisibility,
  treeViewTitle,
  type FileTreeViewMode,
} from "./treeToolbarChrome";

export type { FileTreeViewMode };

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
  /** When provided, show a panel-local collapse control (like BottomDock). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenFile: () => void;
  onAddFolder: () => void;
  canCreate: boolean;
  canMutateSelection: boolean;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onRename: () => void;
  onDelete: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** IDEA Project view header: Select Opened File (locate the active editor). */
  onSelectOpenedFile?: () => void;
  /** IDEA Project view header: Expand All / Collapse All. */
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  /** IDEA tool window ⋮ Options (View Mode, Move to, Resize, Remove, Hide). */
  toolWindowOptions?: () => MenuItem[];
  /** IDEA Appearance › Details: modification time and size after file names. */
  showDetails?: boolean;
  onShowDetailsChange?: (value: boolean) => void;
  children: ReactNode;
}

interface TreeIconButtonProps {
  label: string;
  icon: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
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
  collapsed = false,
  onToggleCollapse,
  onOpenFile,
  onAddFolder,
  canCreate,
  canMutateSelection,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onDelete,
  children,
  onKeyDown,
  onSelectOpenedFile,
  onExpandAll,
  onCollapseAll,
  toolWindowOptions,
  showDetails = false,
  onShowDetailsChange,
}: FileTreePaneProps) {
  const toolbarMenu = useContextMenu();
  const [toolbarWidth, setToolbarWidth] = useState(TREE_DEFAULT_WIDTH_ASSUMPTION);
  const density = treeToolbarDensity(toolbarWidth);
  const visibility = useMemo(() => treeToolbarVisibility(density), [density]);
  // IDEA speed search: typing in the tree opens the search field; it stays
  // while it holds a query.
  const [speedSearchOpen, setSpeedSearchOpen] = useState(false);
  const speedSearchRef = useRef<HTMLInputElement>(null);
  const speedSearchVisible = speedSearchOpen || filter !== "";
  const [speedSearchFocusNonce, setSpeedSearchFocusNonce] = useState(0);
  useEffect(() => {
    if (speedSearchFocusNonce === 0) return;
    speedSearchRef.current?.focus();
  }, [speedSearchFocusNonce]);

  const openSpeedSearch = (initial?: string) => {
    setSpeedSearchOpen(true);
    if (initial !== undefined) onFilterChange(`${filter}${initial}`);
    setSpeedSearchFocusNonce((nonce) => nonce + 1);
  };
  const closeSpeedSearch = () => {
    setSpeedSearchOpen(false);
    onFilterChange("");
    const tree = paneRef.current?.querySelector<HTMLElement>("[data-testid='code-workspace-tree']");
    const row = tree?.querySelector<HTMLElement>("[role='treeitem'][data-selected='true']")
      ?? tree?.querySelector<HTMLElement>("[role='treeitem']");
    (row ?? paneRef.current)?.focus({ preventScroll: true });
  };

  const handlePaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inField = !!target?.closest("input, textarea, select, [contenteditable='true']");
    if (!inField && !event.nativeEvent.isComposing) {
      const printable = event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
      const findChord = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
      if (printable || findChord) {
        event.preventDefault();
        event.stopPropagation();
        openSpeedSearch(printable ? event.key : undefined);
        return;
      }
    }
    onKeyDown?.(event);
  };

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      if (width > 0) setToolbarWidth(width);
    };
    measure();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    ro?.observe(pane);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [paneRef]);

  /** IDEA "Project ▾": the view list of the Project tool window. */
  const openViewSelector = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    toolbarMenu.showAt(rect.left, rect.bottom, [
      {
        label: "Project",
        testId: "code-workspace-tree-view-project",
        checked: viewMode !== "flat",
        onClick: () => { if (viewMode === "flat") onViewModeChange("tree"); },
      },
      {
        label: "Project Files",
        testId: "code-workspace-tree-view-project-files",
        checked: viewMode === "flat",
        onClick: () => onViewModeChange("flat"),
      },
    ]);
  };

  /** IDEA title action New (+): new elements, plus Taomni's workspace entry points. */
  const openNewMenu = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    toolbarMenu.showAt(rect.left, rect.bottom, [
      { label: "File", testId: "code-workspace-tree-new-file", icon: <File className="w-3.5 h-3.5" />, disabled: !canCreate, onClick: onCreateFile },
      { label: "Directory", testId: "code-workspace-tree-new-directory", icon: <FolderOpen className="w-3.5 h-3.5" />, disabled: !canCreate, onClick: onCreateDirectory },
      { separator: true, label: "" },
      { label: "Open File…", testId: "code-workspace-tree-open-file", onClick: onOpenFile },
      { label: "Add Folder to Workspace…", testId: "code-workspace-tree-add-folder", onClick: onAddFolder },
    ]);
  };

  /** IDEA ⋮ Options: Appearance, then the tool window options. */
  const openToolbarOverflow = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [];
    if (onExpandAll && !visibility.showExpandAll) {
      items.push({ label: "Expand All", testId: "code-workspace-tree-menu-expand-all", onClick: onExpandAll }, { separator: true, label: "" });
    }
    items.push({
      label: "Appearance",
      testId: "code-workspace-tree-menu-appearance",
      children: [
        ...(onShowDetailsChange ? [{
          label: "Details",
          testId: "code-workspace-tree-menu-details",
          checked: showDetails,
          onClick: () => onShowDetailsChange(!showDetails),
        }] : []),
        {
          label: "Compact Directories",
          testId: "code-workspace-tree-menu-compact",
          checked: viewMode === "compact",
          disabled: viewMode === "flat",
          onClick: () => onViewModeChange(viewMode === "compact" ? "tree" : "compact"),
        },
        { separator: true, label: "" },
        {
          label: "Zoom In",
          testId: "code-workspace-tree-zoom-in",
          disabled: fontSize >= maxFontSize,
          onClick: () => onFontSizeChange(fontSize + 1),
        },
        {
          label: "Zoom Out",
          testId: "code-workspace-tree-zoom-out",
          disabled: fontSize <= minFontSize,
          onClick: () => onFontSizeChange(fontSize - 1),
        },
        {
          label: `Reset Zoom (${defaultFontSize}px)`,
          testId: "code-workspace-tree-zoom-reset",
          disabled: fontSize === defaultFontSize,
          onClick: () => onFontSizeChange(defaultFontSize),
        },
      ],
    });
    items.push(
      { separator: true, label: "" },
      { label: "Rename…", disabled: !canMutateSelection, onClick: onRename },
      { label: "Delete…", disabled: !canMutateSelection, onClick: onDelete },
    );
    const options = toolWindowOptions?.() ?? [];
    if (options.length > 0) items.push({ separator: true, label: "" }, ...options);
    toolbarMenu.showAt(rect.right, rect.bottom, items);
  };

  return (
    <aside
      ref={paneRef}
      tabIndex={0}
      data-testid="code-workspace-tree-pane"
      data-tree-toolbar-density={density}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-gutter-bg)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--taomni-accent)]"
      style={style}
      onKeyDown={handlePaneKeyDown}
    >
      {/*
        IDEA Project tool window title row: the view selector on the left,
        then New / Select Opened File / Expand All / Collapse All / Options /
        Hide. Speed search replaces a permanent filter row.
      */}
      <div
        data-testid="code-workspace-tree-toolbar"
        className="shrink-0 flex flex-col border-b border-[var(--taomni-code-border)]"
      >
        <div
          data-testid="code-workspace-tree-toolbar-actions"
          className="h-[30px] flex items-center gap-0.5 pl-1 pr-1"
        >
          <button
            type="button"
            data-testid="code-workspace-tree-view-selector"
            aria-haspopup="menu"
            title="Select view"
            className="h-6 min-w-0 inline-flex items-center gap-0.5 rounded px-1.5 text-[12px] font-semibold text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={openViewSelector}
          >
            <span className="truncate">{treeViewTitle(viewMode)}</span>
            <ChevronDown className="w-3 h-3 shrink-0 text-[var(--taomni-code-muted)]" />
          </button>
          <div className="flex-1 min-w-0" />
          <TreeIconButton
            label="New…"
            testId="code-workspace-tree-new"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={openNewMenu}
          />
          {onSelectOpenedFile && (
            <TreeIconButton
              label="Select Opened File (Alt+F1)"
              testId="code-workspace-tree-select-opened"
              icon={<LocateFixed className="w-3.5 h-3.5" />}
              onClick={onSelectOpenedFile}
            />
          )}
          {onExpandAll && visibility.showExpandAll && (
            <TreeIconButton
              label="Expand All"
              testId="code-workspace-tree-expand-all"
              icon={<ChevronsUpDown className="w-3.5 h-3.5" />}
              onClick={onExpandAll}
            />
          )}
          {onCollapseAll && (
            <TreeIconButton
              label="Collapse All"
              testId="code-workspace-tree-collapse-all"
              icon={<ChevronsDownUp className="w-3.5 h-3.5" />}
              onClick={onCollapseAll}
            />
          )}
          <TreeIconButton
            label="Options"
            testId="code-workspace-tree-toolbar-more"
            icon={<MoreVertical className="w-3.5 h-3.5" />}
            onClick={openToolbarOverflow}
          />
          {onToggleCollapse && (
            <TreeIconButton
              label={collapsed ? "Show project tree" : "Hide (Shift+Escape)"}
              testId="code-workspace-tree-collapse"
              icon={<Minus className="w-3.5 h-3.5" />}
              onClick={onToggleCollapse}
            />
          )}
        </div>
      </div>
      {speedSearchVisible && (
        <div
          data-testid="code-workspace-tree-speed-search"
          className="shrink-0 mx-1 mt-1 h-[24px] flex items-center gap-1 rounded border border-[var(--taomni-accent)] bg-[var(--taomni-code-bg)] px-1.5"
        >
          <Search className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={speedSearchRef}
            type="search"
            data-testid="code-workspace-tree-filter"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                closeSpeedSearch();
              }
            }}
            placeholder="Search for"
            aria-label="Filter files"
            className="min-w-0 flex-1 bg-transparent outline-none text-[var(--taomni-code-text)] placeholder:text-[var(--taomni-code-muted)]"
            style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
          />
          <button
            type="button"
            data-testid="code-workspace-tree-speed-search-close"
            title="Close search"
            aria-label="Close search"
            className="h-5 w-5 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={closeSpeedSearch}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      <div
        data-testid="code-workspace-tree"
        role="tree"
        aria-label="Project files"
        className="group/tree flex-1 min-h-0 overflow-auto py-1"
        style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
      >
        {children}
      </div>
      {toolbarMenu.render}
    </aside>
  );
}

/** Default before first measure — treat as wide so SSR/tests show full primary actions. */
const TREE_DEFAULT_WIDTH_ASSUMPTION = 360;

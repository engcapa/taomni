import { ChevronRight, File, Folder, Hash, MoreHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { type BreadcrumbItem, type BreadcrumbPathSegment, type BreadcrumbsProps, type OpenPopup } from "./breadcrumbs/model";
import { collapsedBreadcrumbItems, sortPathChildren, symbolChainAtPosition, symbolSiblingsAt } from "./breadcrumbs/paths";
import { SegmentPopup } from "./breadcrumbs/SegmentPopup";
import { navigateSegments } from "./navigationBarModel";

export function Breadcrumbs({
  pathSegments,
  symbols,
  position,
  loadPathChildren,
  onPathNavigate,
  pathActionsForSegment,
  onPathClick,
  onSymbolClick,
  activeNavigationBar = false,
  onCloseNavigationBar,
  variant = "bar",
}: BreadcrumbsProps) {
  const computedSymbolChain = useMemo(
    () => symbolChainAtPosition(symbols, position),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position fields, not identity
    [symbols, position.line, position.character],
  );
  // Caret moves inside the same member keep the same chain identity, so the
  // width measurement below does not force a layout on every keystroke.
  const symbolChainRef = useRef(computedSymbolChain);
  if (
    symbolChainRef.current !== computedSymbolChain
    && (symbolChainRef.current.length !== computedSymbolChain.length
      || symbolChainRef.current.some((symbol, index) => symbol !== computedSymbolChain[index]))
  ) {
    symbolChainRef.current = computedSymbolChain;
  }
  const symbolChain = symbolChainRef.current;
  const navRef = useRef<HTMLElement | null>(null);
  const fullPathMeasureRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [popup, setPopup] = useState<OpenPopup | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [navBarFocusedIndex, setNavBarFocusedIndex] = useState<number | null>(null);
  const loadGenerationRef = useRef(0);

  const fullItems = useMemo<BreadcrumbItem[]>(() => [
    ...pathSegments.map((value) => ({ type: "path" as const, value })),
    ...symbolChain.map((value) => ({ type: "symbol" as const, value })),
  ], [pathSegments, symbolChain]);
  const compactItems = useMemo(
    () => collapsedBreadcrumbItems(pathSegments, symbolChain),
    [pathSegments, symbolChain],
  );
  const visibleItems = collapsed ? compactItems : fullItems;

  useEffect(() => {
    if (activeNavigationBar) {
      setNavBarFocusedIndex(visibleItems.length > 0 ? visibleItems.length - 1 : 0);
      navRef.current?.focus();
    } else {
      setNavBarFocusedIndex(null);
    }
  }, [activeNavigationBar, visibleItems.length]);

  useLayoutEffect(() => {
    const updateCollapsedState = () => {
      const availableWidth = navRef.current?.clientWidth ?? 0;
      const fullPathWidth = fullPathMeasureRef.current?.getBoundingClientRect().width ?? 0;
      if (availableWidth > 0 && fullPathWidth > 0) {
        setCollapsed(fullPathWidth > availableWidth);
      }
    };

    updateCollapsedState();
    if (typeof ResizeObserver === "undefined" || !navRef.current) return;
    const observer = new ResizeObserver(updateCollapsedState);
    observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [fullItems]);

  // Close popup when the active trail changes (file switch / cursor jump).
  useEffect(() => {
    // Invalidate an in-flight directory listing whenever the active trail or
    // caret changes, so a late response cannot reopen an obsolete popup.
    loadGenerationRef.current += 1;
    setPopup(null);
    setQuery("");
    setSelectedIndex(0);
  }, [pathSegments, position.line, position.character]);

  const closePopup = useCallback((restoreFocus = false) => {
    loadGenerationRef.current += 1;
    setPopup(null);
    setQuery("");
    setSelectedIndex(0);
    if (restoreFocus) navRef.current?.focus();
  }, []);

  const actionsForOpen = useMemo(() => {
    if (!popup || popup.kind !== "path" || !pathActionsForSegment) return [];
    return pathActionsForSegment(popup.segment);
  }, [pathActionsForSegment, popup]);

  const openPathPopup = useCallback(async (
    segment: BreadcrumbPathSegment,
    anchorEl: HTMLElement,
  ) => {
    const anchor = anchorEl.getBoundingClientRect();
    if (!loadPathChildren) {
      onPathClick?.(segment);
      return;
    }
    const generation = ++loadGenerationRef.current;
    setQuery("");
    setSelectedIndex(0);
    setPopup({
      kind: "path",
      segment,
      anchor,
      children: [],
      loading: true,
      error: null,
    });
    try {
      const children = await loadPathChildren(segment);
      if (generation !== loadGenerationRef.current) return;
      const activeIndex = Math.max(0, sortPathChildren(children).findIndex((child) => child.active));
      setSelectedIndex(activeIndex);
      setPopup({
        kind: "path",
        segment,
        anchor,
        children,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setPopup({
        kind: "path",
        segment,
        anchor,
        children: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [loadPathChildren, onPathClick]);

  const openSymbolPopup = useCallback((
    symbol: LspDocumentSymbol,
    anchorEl: HTMLElement,
  ) => {
    const siblings = symbolSiblingsAt(symbols, symbol);
    if (siblings.length <= 1) {
      onSymbolClick?.(symbol);
      return;
    }
    const anchor = anchorEl.getBoundingClientRect();
    const activeIndex = Math.max(0, siblings.findIndex((item) =>
      item.name === symbol.name
      && item.selectionRange.start.line === symbol.selectionRange.start.line
      && item.selectionRange.start.character === symbol.selectionRange.start.character
    ));
    setQuery("");
    setSelectedIndex(activeIndex);
    setPopup({ kind: "symbol", symbol, siblings, anchor });
  }, [onSymbolClick, symbols]);

  const openCollapsedPopup = useCallback((
    segments: BreadcrumbPathSegment[],
    anchorEl: HTMLElement,
  ) => {
    if (segments.length === 0) return;
    setQuery("");
    setSelectedIndex(0);
    setPopup({
      kind: "collapsed",
      segments,
      anchor: anchorEl.getBoundingClientRect(),
    });
  }, []);

  const handlePathContextMenu = useCallback((
    event: ReactMouseEvent,
    segment: BreadcrumbPathSegment,
  ) => {
    const actions = pathActionsForSegment?.(segment) ?? [];
    if (actions.length === 0 && !loadPathChildren) return;
    event.preventDefault();
    event.stopPropagation();
    const anchorEl = event.currentTarget as HTMLElement;
    void openPathPopup(segment, anchorEl);
  }, [loadPathChildren, openPathPopup, pathActionsForSegment]);

  const handleNavKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (!activeNavigationBar && navBarFocusedIndex === null) return;
    if (popup) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setNavBarFocusedIndex((prev) => navigateSegments(prev ?? visibleItems.length - 1, visibleItems.length, "left"));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setNavBarFocusedIndex((prev) => navigateSegments(prev ?? 0, visibleItems.length, "right"));
    } else if (event.key === "Home") {
      event.preventDefault();
      setNavBarFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setNavBarFocusedIndex(visibleItems.length - 1);
    } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const currentIdx = navBarFocusedIndex ?? visibleItems.length - 1;
      const currentItem = visibleItems[currentIdx];
      if (!currentItem) return;
      const targetBtn = navRef.current?.querySelector<HTMLElement>(`[data-nav-index="${currentIdx}"]`);
      if (targetBtn) {
        if (currentItem.type === "path") void openPathPopup(currentItem.value, targetBtn);
        if (currentItem.type === "symbol") openSymbolPopup(currentItem.value, targetBtn);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setNavBarFocusedIndex(null);
      onCloseNavigationBar?.();
    }
  }, [activeNavigationBar, navBarFocusedIndex, onCloseNavigationBar, openPathPopup, openSymbolPopup, popup, visibleItems]);

  const renderItems = (items: BreadcrumbItem[], compact: boolean, interactive: boolean) => items.map((item, index) => {
    const path = item.type === "path" ? item.value : null;
    const symbol = item.type === "symbol" ? item.value : null;
    const label = path?.label ?? symbol?.name ?? "";
    // IDEA's navigation bar keeps the file name whole and truncates the
    // surrounding directories/members first; a narrow status bar otherwise
    // squeezed the file segment to zero width (ED-PARITY-011 DEC-011-02).
    const flexible = compact && path?.kind !== "file";
    const isFocused = navBarFocusedIndex === index;
    const icon = path?.kind === "root" || path?.kind === "directory" ? (
      <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
    ) : path?.kind === "file" ? (
      <File className="h-3 w-3 shrink-0" />
    ) : item.type === "collapsed" ? (
      <MoreHorizontal className="h-3 w-3" />
    ) : (
      <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
    );

    if (item.type === "collapsed") {
      return (
        <span key={`collapsed:${index}`} className="inline-flex shrink-0 items-center">
          {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
          {interactive ? (
            <button
              type="button"
              className={`inline-flex h-5 items-center rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""
                }`}
              aria-label="Hidden breadcrumb segments"
              id={`code-workspace-breadcrumb-segment-${index}`}
              tabIndex={activeNavigationBar ? -1 : 0}
              data-testid="code-workspace-breadcrumb-collapsed"
              data-nav-index={index}
              onClick={(event) => {
                if (item.hiddenPaths.length > 0) {
                  openCollapsedPopup(item.hiddenPaths, event.currentTarget);
                }
              }}
            >
              {icon}
            </button>
          ) : (
            <span className="inline-flex h-5 items-center rounded px-1">{icon}</span>
          )}
        </span>
      );
    }

    const content = (
      <>
        {icon}
        <span className={flexible ? "truncate" : undefined}>{label}</span>
      </>
    );

    return (
      <span
        key={`${item.type}:${label}:${index}`}
        className={`inline-flex min-w-0 items-center ${flexible ? "flex-1" : "shrink-0"}`}
      >
        {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0" />}
        {interactive ? (
          <button
            type="button"
            className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${flexible ? "flex-1" : ""
              } ${isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""}`}
            aria-haspopup="listbox"
            aria-current={index === items.length - 1 ? (path?.kind === "file" ? "page" : symbol ? "location" : undefined) : undefined}
            id={`code-workspace-breadcrumb-segment-${index}`}
            tabIndex={activeNavigationBar ? -1 : 0}
            data-nav-index={index}
            data-focused={isFocused ? "true" : undefined}
            data-testid={path
              ? `code-workspace-breadcrumb-path-${path.kind}`
              : "code-workspace-breadcrumb-symbol"}
            onClick={(event) => {
              if (path) void openPathPopup(path, event.currentTarget);
              if (symbol) openSymbolPopup(symbol, event.currentTarget);
            }}
            onContextMenu={(event) => {
              if (path) handlePathContextMenu(event, path);
            }}
          >
            {content}
          </button>
        ) : (
          <span className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 ${flexible ? "flex-1" : ""}`}>
            {content}
          </span>
        )}
      </span>
    );
  });

  return (
    <nav
      ref={navRef}
      tabIndex={activeNavigationBar ? 0 : -1}
      aria-activedescendant={navBarFocusedIndex === null || visibleItems.length === 0
        ? undefined
        : `code-workspace-breadcrumb-segment-${navBarFocusedIndex}`}
      onKeyDown={handleNavKeyDown}
      aria-label="Editor breadcrumbs"
      data-testid="code-workspace-breadcrumbs"
      data-variant={variant}
      className={variant === "statusbar"
        ? "relative flex h-full min-w-0 flex-1 items-center overflow-hidden text-[11px] text-[var(--taomni-status-text)] outline-none"
        : "relative flex h-7 shrink-0 items-center overflow-hidden border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[11px] text-[var(--taomni-code-muted)] outline-none"}
    >
      <div
        ref={fullPathMeasureRef}
        aria-hidden="true"
        className="pointer-events-none absolute invisible w-max whitespace-nowrap"
      >
        {renderItems(fullItems, false, false)}
      </div>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {renderItems(visibleItems, collapsed, true)}
      </div>
      {popup && (
        <SegmentPopup
          open={popup}
          query={query}
          selectedIndex={selectedIndex}
          actions={actionsForOpen}
          onQueryChange={(value) => {
            setQuery(value);
            setSelectedIndex(0);
          }}
          onSelectedIndexChange={setSelectedIndex}
          onClose={closePopup}
          onPickPathChild={(child) => {
            if (popup.kind === "path") {
              onPathNavigate?.(child, popup.segment);
            }
            closePopup();
          }}
          onPickSymbol={(symbol) => {
            onSymbolClick?.(symbol);
            closePopup();
          }}
          onPickCollapsedSegment={(segment) => {
            // Swap the collapsed list for that intermediate segment's children menu.
            const anchor = popup.kind === "collapsed"
              ? popup.anchor
              : navRef.current?.getBoundingClientRect() ?? new DOMRect(8, 8, 0, 0);
            if (!loadPathChildren) {
              onPathClick?.(segment);
              closePopup();
              return;
            }
            const generation = ++loadGenerationRef.current;
            setQuery("");
            setSelectedIndex(0);
            setPopup({
              kind: "path",
              segment,
              anchor,
              children: [],
              loading: true,
              error: null,
            });
            void loadPathChildren(segment).then((children) => {
              if (generation !== loadGenerationRef.current) return;
              const activeIndex = Math.max(0, sortPathChildren(children).findIndex((child) => child.active));
              setSelectedIndex(activeIndex);
              setPopup({
                kind: "path",
                segment,
                anchor,
                children,
                loading: false,
                error: null,
              });
            }).catch((error) => {
              if (generation !== loadGenerationRef.current) return;
              setPopup({
                kind: "path",
                segment,
                anchor,
                children: [],
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }}
          onAction={(action) => {
            action.onSelect();
            closePopup();
          }}
        />
      )}
    </nav>
  );
}

export { type BreadcrumbPathAction, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "./breadcrumbs/model";

export { collapsedBreadcrumbItems, symbolChainAtPosition, symbolSiblingsAt } from "./breadcrumbs/paths";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface BottomDockTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  content: ReactNode;
}

interface BottomDockProps {
  open: boolean;
  activeTab: string;
  tabs: BottomDockTab[];
  onOpenChange: (open: boolean) => void;
  onActiveTabChange: (tabId: string) => void;
  /** Controlled height in px; when omitted, dock manages its own persisted height. */
  height?: number;
  onHeightChange?: (height: number) => void;
  onEscape?: () => void;
  maxHeight?: number;
}

export const BOTTOM_DOCK_HEADER_HEIGHT = 50;
export const BOTTOM_DOCK_MIN_HEIGHT = 49;
export const BOTTOM_DOCK_MAX_HEIGHT = 849;
export const BOTTOM_DOCK_DEFAULT_HEIGHT = 323;
const BOTTOM_DOCK_HEIGHT_KEY = "taomni.codeWorkspace.bottomDockHeight.v1";

function clampHeight(value: number, max = BOTTOM_DOCK_MAX_HEIGHT): number {
  return Math.max(BOTTOM_DOCK_MIN_HEIGHT, Math.min(max, Math.round(value)));
}

function readStoredHeight(): number {
  try {
    const raw = window.localStorage.getItem(BOTTOM_DOCK_HEIGHT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return clampHeight(parsed);
  } catch {
    // Ignore storage failures.
  }
  return BOTTOM_DOCK_DEFAULT_HEIGHT;
}

function writeStoredHeight(height: number): void {
  try {
    window.localStorage.setItem(BOTTOM_DOCK_HEIGHT_KEY, String(clampHeight(height)));
  } catch {
    // Ignore storage failures.
  }
}

export function BottomDock({
  open,
  activeTab,
  tabs,
  onOpenChange,
  onActiveTabChange,
  height: controlledHeight,
  onHeightChange,
  onEscape,
  maxHeight = BOTTOM_DOCK_MAX_HEIGHT,
}: BottomDockProps) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const [uncontrolledHeight, setUncontrolledHeight] = useState(readStoredHeight);
  const preferredHeight = controlledHeight ?? uncontrolledHeight;
  const effectiveHeight = clampHeight(preferredHeight, maxHeight);
  const dragRef = useRef<{ startY: number; startHeight: number; requestId: number } | null>(null);
  const dragRequestIdRef = useRef<number>(0);
  const activeCleanUpRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      activeCleanUpRef.current?.();
    };
  }, []);

  // Tab overflow dropdown state and measurement
  const headerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const setHeight = useCallback((next: number) => {
    const clamped = clampHeight(next, BOTTOM_DOCK_MAX_HEIGHT);
    if (onHeightChange) onHeightChange(clamped);
    else {
      setUncontrolledHeight(clamped);
      writeStoredHeight(clamped);
    }
  }, [onHeightChange]);

  useEffect(() => {
    if (controlledHeight != null) return;
    writeStoredHeight(uncontrolledHeight);
  }, [controlledHeight, uncontrolledHeight]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        overflowMenuRef.current?.contains(e.target as Node)
        || overflowButtonRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [overflowOpen]);

  const selectTab = (tabId: string) => {
    if (open && tabId === active?.id) {
      onOpenChange(false);
      return;
    }
    onActiveTabChange(tabId);
    onOpenChange(true);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open) return;
    event.preventDefault();
    activeCleanUpRef.current?.();
    const requestId = ++dragRequestIdRef.current;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: preferredHeight, requestId };

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.requestId !== requestId) return;
      // Dragging the top handle upward increases height.
      const delta = drag.startY - moveEvent.clientY;
      setHeight(drag.startHeight + delta);
    };
    const onCleanUp = () => {
      if (dragRequestIdRef.current !== requestId) return;
      activeCleanUpRef.current = null;
      dragRef.current = null;
      try {
        target.releasePointerCapture?.(event.pointerId);
      } catch {
        // Ignore if pointer capture already lost
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onCleanUp);
      window.removeEventListener("pointercancel", onCleanUp);
      document.removeEventListener("visibilitychange", onCleanUp);
      window.removeEventListener("blur", onCleanUp);
    };
    activeCleanUpRef.current = onCleanUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onCleanUp);
    window.addEventListener("pointercancel", onCleanUp);
    document.addEventListener("visibilitychange", onCleanUp);
    window.addEventListener("blur", onCleanUp);
  };

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHeight(effectiveHeight + 20);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHeight(effectiveHeight - 20);
    }
  };

  // Determine visible vs overflow tabs based on header width
  // Estimated ~100px per tab button + 50px controls margin
  const approxTabWidth = 100;
  const reserveWidth = 80;
  const maxFitCount = containerWidth != null && containerWidth > 0
    ? Math.max(1, Math.floor((containerWidth - reserveWidth) / approxTabWidth))
    : tabs.length;

  let visibleTabs = tabs;
  let overflowTabs: BottomDockTab[] = [];

  if (maxFitCount < tabs.length) {
    // If active tab would be hidden in overflow, ensure it is in visibleTabs
    const activeIndex = tabs.findIndex((t) => t.id === active?.id);
    if (activeIndex >= maxFitCount && activeIndex >= 0) {
      const activeTabItem = tabs[activeIndex]!;
      const head = tabs.slice(0, maxFitCount - 1);
      visibleTabs = [...head, activeTabItem];
      overflowTabs = tabs.filter((t) => !visibleTabs.includes(t));
    } else {
      visibleTabs = tabs.slice(0, maxFitCount);
      overflowTabs = tabs.slice(maxFitCount);
    }
  }

  const handleDockKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || (event.nativeEvent as KeyboardEvent).isComposing) {
      return;
    }
    if (event.key === "Escape") {
      if (overflowOpen) {
        event.preventDefault();
        event.stopPropagation();
        setOverflowOpen(false);
        overflowButtonRef.current?.focus();
        return;
      }
      onEscape?.();
    }
  };

  return (
    <section
      data-testid="code-workspace-bottom-dock"
      data-open={open || undefined}
      onKeyDown={handleDockKeyDown}
      className="shrink-0 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] relative flex flex-col"
    >
      {open && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize bottom panel"
          aria-valuenow={effectiveHeight}
          aria-valuemin={BOTTOM_DOCK_MIN_HEIGHT}
          aria-valuemax={maxHeight}
          data-testid="code-workspace-bottom-dock-resize"
          className="h-1.5 cursor-row-resize bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] focus:bg-[var(--taomni-accent)] transition-colors"
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      )}
      <div
        ref={headerRef}
        className="h-[50px] flex items-center gap-1 overflow-hidden px-2 border-b border-[var(--taomni-code-border)]/50"
      >
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
          {visibleTabs.map((tab) => {
            const selected = tab.id === active?.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-testid={`code-workspace-bottom-tab-${tab.id}`}
                aria-selected={selected && open}
                data-active={(selected && open) || undefined}
                className="h-8 shrink-0 inline-flex items-center gap-1.5 rounded px-2.5 text-[12px] font-medium text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
                onClick={() => selectTab(tab.id)}
              >
                {tab.icon}
                <span className="truncate max-w-[120px]">{tab.label}</span>
                {(typeof tab.badge === "number" ? tab.badge > 0 : !!tab.badge) && (
                  <span className="min-w-4 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-center text-[10px] tabular-nums text-[var(--taomni-code-text)]">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}

          {overflowTabs.length > 0 && (
            <div className="relative shrink-0">
              <button
                ref={overflowButtonRef}
                type="button"
                data-testid="code-workspace-bottom-tab-overflow"
                aria-label="More tabs"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                title="More tabs"
                className="h-8 w-8 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
                onClick={() => setOverflowOpen((prev) => !prev)}
              >
                <ChevronDown className="h-4 w-4" />
              </button>

              {overflowOpen && (
                <div
                  ref={overflowMenuRef}
                  role="menu"
                  data-testid="code-workspace-bottom-tab-overflow-menu"
                  className="absolute left-0 top-9 z-50 min-w-44 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] py-1 shadow-lg"
                >
                  {overflowTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="menuitem"
                      data-testid={`code-workspace-bottom-tab-overflow-${tab.id}`}
                      aria-selected={tab.id === active?.id}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
                      onClick={() => {
                        selectTab(tab.id);
                        setOverflowOpen(false);
                      }}
                    >
                      <span className="shrink-0">{tab.icon}</span>
                      <span className="flex-1 text-left truncate">{tab.label}</span>
                      {tab.badge && (
                        <span className="rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-[10px] tabular-nums">
                          {tab.badge}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {active && (
          <button
            type="button"
            title={open ? "Collapse bottom panel" : "Expand bottom panel"}
            aria-label={open ? "Collapse bottom panel" : "Expand bottom panel"}
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => onOpenChange(!open)}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Keep every panel mounted so stateful tools (search, terminals)
          survive tab switches and dock collapse; hide inactive ones. */}
      <div
        hidden={!open || !active}
        data-testid="code-workspace-bottom-dock-body"
        className="min-h-0 overflow-hidden"
        style={{ height: open ? Math.max(0, effectiveHeight - BOTTOM_DOCK_HEADER_HEIGHT) : 0 }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={tab.label}
            hidden={tab.id !== active?.id}
            className="h-full min-h-0"
          >
            {tab.content}
          </div>
        ))}
      </div>
    </section>
  );
}

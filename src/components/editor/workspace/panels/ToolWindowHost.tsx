import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, MoreVertical } from "lucide-react";
import { ContextMenu, type MenuItem } from "../../../ContextMenu";
import { KeepAliveToolPanel } from "./BottomDock";

/**
 * Re-parentable tool window content (ED-PARITY-024).
 *
 * Every tool window renders once, through a portal, into its own host node.
 * The area that currently shows the window adopts that node; hidden windows
 * sit in a parking element. Moving a window between the left, right and bottom
 * areas therefore keeps its React state (terminal sessions, search results,
 * debugger state) instead of remounting it.
 */
export interface ToolWindowNodes {
  node: (id: string, label: string) => HTMLDivElement;
  park: (node: HTMLDivElement) => void;
  setParking: (element: HTMLDivElement | null) => void;
}

export function useToolWindowNodes(): ToolWindowNodes {
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const parkingRef = useRef<HTMLDivElement | null>(null);
  const node = useCallback((id: string, label: string) => {
    let element = nodesRef.current.get(id);
    if (!element) {
      element = document.createElement("div");
      element.className = "h-full min-h-0 min-w-0";
      element.setAttribute("role", "tabpanel");
      element.setAttribute("data-tool-window-content", id);
      nodesRef.current.set(id, element);
      parkingRef.current?.appendChild(element);
    }
    if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
    return element;
  }, []);
  const park = useCallback((element: HTMLDivElement) => {
    const parking = parkingRef.current;
    if (parking && element.parentElement !== parking) parking.appendChild(element);
  }, []);
  const setParking = useCallback((element: HTMLDivElement | null) => {
    parkingRef.current = element;
    if (!element) return;
    for (const node of nodesRef.current.values()) {
      if (!node.isConnected) element.appendChild(node);
    }
  }, []);
  // One identity for the lifetime of the workspace: slots re-adopt their
  // node whenever this object changes.
  return useMemo(() => ({ node, park, setParking }), [node, park, setParking]);
}

/** Renders one tool window's content into its host node. */
export function ToolWindowPortal({
  nodes,
  id,
  label,
  active,
  onEscape,
  children,
}: {
  nodes: ToolWindowNodes;
  id: string;
  label: string;
  active: boolean;
  /**
   * IDEA: Esc inside a tool window returns focus to the editor. The portal
   * breaks React bubbling to the area that hosts the content (the bottom
   * dock's own handler never sees it), so each window handles it here.
   */
  onEscape?: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div
      style={{ display: "contents" }}
      onKeyDown={onEscape ? (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        onEscape();
      } : undefined}
    >
      <KeepAliveToolPanel active={active}>{children}</KeepAliveToolPanel>
    </div>,
    nodes.node(id, label),
    `tool-window-${id}`,
  );
}

/** A visible area slot: adopts the tool window's host node while mounted. */
export function ToolWindowSlot({
  nodes,
  id,
  label,
  className = "h-full min-h-0 min-w-0",
  testId,
}: {
  nodes: ToolWindowNodes;
  id: string;
  label: string;
  className?: string;
  testId?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const element = nodes.node(id, label);
    container.appendChild(element);
    return () => {
      nodes.park(element);
    };
  }, [id, label, nodes]);
  return <div ref={containerRef} className={className} data-tool-window-slot={id} data-testid={testId} />;
}

export interface ToolWindowPaneProps {
  nodes: ToolWindowNodes;
  toolId: string;
  title: string;
  /** Tool-specific header controls (tabs, toolbar) after the title. */
  headerExtra?: ReactNode;
  /** Items of the header ⋮ menu (tool actions, View Mode, Move to, Resize…). */
  optionsItems: MenuItem[];
  onHide: () => void;
  /** Legacy bottom-dock testids for the primary bottom pane. */
  legacyTestIds?: boolean;
  className?: string;
}

/**
 * IDEA tool window decorator: header (title, tool controls, ⋮ Options, —
 * Hide) over the adopted content node.
 */
export function ToolWindowPane({
  nodes,
  toolId,
  title,
  headerExtra,
  optionsItems,
  onHide,
  legacyTestIds = false,
  className = "flex h-full min-h-0 min-w-0 flex-col",
}: ToolWindowPaneProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const optionsRef = useRef<HTMLButtonElement | null>(null);
  const suffix = legacyTestIds ? "" : `-${toolId}`;
  return (
    <div data-testid={`code-workspace-tool-window-${toolId}`} data-tool-window-id={toolId} className={className}>
      <div
        data-testid={`code-workspace-tool-window-header${suffix}`}
        className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)]/50 px-2"
      >
        <span data-testid={`code-workspace-tool-window-title${suffix}`} className="shrink-0 text-[12px] font-medium text-[var(--taomni-code-text)]">
          {title}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{headerExtra}</div>
        <button
          ref={optionsRef}
          type="button"
          data-testid={`code-workspace-tool-window-options${suffix}`}
          aria-label={`${title} options`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title="Options"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={() => {
            const rect = optionsRef.current?.getBoundingClientRect();
            setMenu(menu ? null : { x: rect ? rect.right - 220 : 0, y: rect ? rect.bottom + 2 : 0 });
          }}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid={`code-workspace-tool-window-hide${suffix}`}
          aria-label={`Hide ${title}`}
          title="Hide (Shift+Esc)"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onHide}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ToolWindowSlot nodes={nodes} id={toolId} label={title} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
      {menu && (
        <ContextMenu
          items={optionsItems}
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            optionsRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

const SIDE_SPLIT_RATIO_KEY = "taomni.codeWorkspace.sideSplitRatio.v1";

function readSideSplitRatio(side: "left" | "right"): number {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDE_SPLIT_RATIO_KEY) ?? "{}") as Record<string, unknown>;
    const value = parsed[side];
    if (typeof value === "number" && value > 0.1 && value < 0.9) return value;
  } catch {
    // Ignore storage failures.
  }
  return 0.55;
}

function writeSideSplitRatio(side: "left" | "right", ratio: number): void {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDE_SPLIT_RATIO_KEY) ?? "{}") as Record<string, number>;
    window.localStorage.setItem(SIDE_SPLIT_RATIO_KEY, JSON.stringify({ ...parsed, [side]: ratio }));
  } catch {
    // Ignore storage failures.
  }
}

/**
 * A side tool window area (IDEA left/right). The top anchor fills the area;
 * a window docked at the bottom anchor splits it vertically.
 */
export function ToolWindowSplitArea({
  side,
  primary,
  secondary,
}: {
  side: "left" | "right";
  primary: ReactNode;
  secondary: ReactNode;
}) {
  const [ratio, setRatio] = useState(() => readSideSplitRatio(side));
  const containerRef = useRef<HTMLDivElement | null>(null);
  const both = !!primary && !!secondary;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    let latest = ratio;
    const onMove = (moveEvent: PointerEvent) => {
      latest = Math.max(0.15, Math.min(0.85, (moveEvent.clientY - rect.top) / rect.height));
      setRatio(latest);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      writeSideSplitRatio(side, latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return (
    <div ref={containerRef} data-testid={`code-workspace-${side}-tool-split`} className="flex h-full min-h-0 flex-col">
      {primary && (
        <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: both ? `0 0 ${Math.round(ratio * 100)}%` : "1 1 auto" }}>
          {primary}
        </div>
      )}
      {both && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${side} tool windows`}
          className="h-1 shrink-0 cursor-row-resize bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
          onPointerDown={onPointerDown}
        />
      )}
      {secondary && <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{secondary}</div>}
    </div>
  );
}

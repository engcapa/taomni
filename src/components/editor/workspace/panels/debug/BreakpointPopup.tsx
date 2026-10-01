import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DebugBreakpoint } from "../../dapDebugModel";
import { breakpointDisplayName } from "../../debugBreakpointProperties";
import { BreakpointPropertiesPanel } from "./BreakpointPropertiesPanel";
import { ContextMenu } from "../../../../ContextMenu";

export interface BreakpointPopupProps {
  path: string;
  breakpoint: DebugBreakpoint;
  /** Screen point under the gutter row the popup opens from. */
  anchor: { x: number; y: number };
  /** Show the whole property set (IDEA opens logging breakpoints expanded). */
  expanded?: boolean;
  otherBreakpoints: Array<{ path: string; line: number }>;
  onChange: (options: Partial<DebugBreakpoint>) => void;
  /** "More (Ctrl+Shift+F8)": open the Breakpoints dialog on this breakpoint. */
  onMore: () => void;
  onClose: () => void;
}

/**
 * IDEA's breakpoint balloon (right-click a breakpoint): Enabled / Suspend /
 * Condition with "More" and "Done". Escape, Done and a click outside close
 * it; property edits apply immediately.
 */
export function BreakpointPopup({
  path,
  breakpoint,
  anchor,
  expanded = false,
  otherBreakpoints,
  onChange,
  onMore,
  onClose,
}: BreakpointPopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y + 2 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.x, window.innerWidth - rect.width - margin));
    // Open upward when the balloon would leave the window below the row.
    const below = anchor.y + 2;
    const top = below + rect.height > window.innerHeight - margin
      ? Math.max(margin, anchor.y - rect.height - 20)
      : below;
    setPosition({ left, top });
  }, [anchor.x, anchor.y, expanded]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Breakpoint ${breakpointDisplayName(path, breakpoint.line)}`}
      data-testid="debug-breakpoint-popup"
      className="fixed z-[80] w-[340px] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-2.5 shadow-lg"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div data-testid="debug-breakpoint-popup-title" className="mb-2 truncate font-semibold text-[11px]">
        {breakpointDisplayName(path, breakpoint.line)}
      </div>
      <BreakpointPropertiesPanel
        path={path}
        breakpoint={breakpoint}
        compact={!expanded}
        otherBreakpoints={otherBreakpoints}
        onChange={onChange}
        onSubmit={onClose}
        autoFocusCondition={!expanded}
        testIdPrefix="debug-breakpoint-popup"
      />
      <div className="mt-2.5 flex items-center justify-between">
        <button
          type="button"
          data-testid="debug-breakpoint-popup-more"
          className="text-[11px] text-[var(--taomni-accent)] hover:underline"
          onClick={onMore}
        >
          More (Ctrl+Shift+F8)
        </button>
        <button
          type="button"
          data-testid="debug-breakpoint-popup-done"
          className="h-6 rounded border border-[var(--taomni-code-border)] px-3 text-[11px] hover:bg-[var(--taomni-hover-bg)]"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Right-click on a gutter line without a breakpoint: IDEA's
 * XDebugger.Hover.Breakpoint.Context.Menu (Add / Conditional / Logging).
 */
export function GutterBreakpointMenu({
  menu,
  onAdd,
  onClose,
}: {
  menu: { x: number; y: number };
  onAdd: (kind: "plain" | "conditional" | "logging") => void;
  onClose: () => void;
}) {
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      items={[
        { label: "Add Breakpoint", testId: "debug-gutter-menu-add", onClick: () => onAdd("plain") },
        { label: "Add Conditional Breakpoint…", testId: "debug-gutter-menu-add-conditional", onClick: () => onAdd("conditional") },
        { label: "Add Logging Breakpoint…", testId: "debug-gutter-menu-add-logging", onClick: () => onAdd("logging") },
      ]}
    />
  );
}

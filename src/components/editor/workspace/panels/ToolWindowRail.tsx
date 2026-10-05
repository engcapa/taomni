import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { ContextMenu, type MenuItem } from "../../../ContextMenu";
import {
  STRIPE_MAX_WIDTH,
  STRIPE_MIN_WIDTH,
  TOOL_WINDOW_ANCHORS,
  TOOL_WINDOW_ANCHOR_LABELS,
  clampStripeWidth,
  type ToolWindowAnchor,
} from "../toolWindowLayout";

export interface ToolWindowRailItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** The tool window is currently visible (IDEA: highlighted stripe button). */
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Display label of the activation shortcut, e.g. `Alt+1`. */
  shortcut?: string;
  testId?: string;
  badge?: ReactNode;
  /** Current dock anchor; enables the IDEA Move submenu. */
  anchor?: ToolWindowAnchor;
  onSelect: () => void;
}

export interface ToolWindowRailProps {
  side: "left" | "right";
  top: readonly ToolWindowRailItem[];
  bottom?: readonly ToolWindowRailItem[];
  /** Host element for buttons rendered by another owner. */
  bottomSlotRef?: Ref<HTMLDivElement>;
  /** Extra buttons after the bottom group (e.g. More tool windows). */
  footer?: ReactNode;
  /** Rendered stripe width in px (IDEA: 40 icon-only, 40–100 with names). */
  width?: number;
  showNames?: boolean;
  onResize?: (width: number) => void;
  onToggleShowNames?: () => void;
  onMove?: (id: string, anchor: ToolWindowAnchor) => void;
  onHide?: (id: string) => void;
  onRemoveFromSidebar?: (id: string) => void;
  /**
   * ED-PARITY-027: rendered inside the main sidebar rail, which owns the
   * background and border; the stripe fills the rail's free height.
   */
  embedded?: boolean;
}

/**
 * IDEA new-UI tool window stripe (ED-PARITY-024): square icon buttons, with
 * the names under the icons when "Show Tool Window Names" is on. The inner
 * edge resizes the stripe (40–100 px) while names are shown; right-click a
 * button for Hide / Move / Show Tool Window Names, or the stripe background
 * for the names toggle alone. Clicking a button shows the window, or hides it
 * when it is already visible.
 */
export function ToolWindowRail({
  side,
  top,
  bottom = [],
  bottomSlotRef,
  footer,
  width = 40,
  showNames = false,
  onResize,
  onToggleShowNames,
  onMove,
  onHide,
  onRemoveFromSidebar,
  embedded = false,
}: ToolWindowRailProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const namesItem: MenuItem = {
    label: "Show Tool Window Names",
    testId: "code-workspace-tool-rail-menu-show-names",
    checked: showNames,
    onClick: () => onToggleShowNames?.(),
  };

  const openButtonMenu = (event: ReactMouseEvent, item: ToolWindowRailItem) => {
    event.preventDefault();
    event.stopPropagation();
    const items: MenuItem[] = [
      {
        label: item.active ? "Hide" : "Show",
        testId: "code-workspace-tool-rail-menu-toggle",
        shortcut: item.shortcut,
        disabled: item.disabled,
        onClick: () => (item.active ? onHide?.(item.id) : item.onSelect()),
      },
    ];
    if (item.anchor && onMove) {
      items.push({ label: "", separator: true });
      items.push({
        label: "Move",
        testId: "code-workspace-tool-rail-menu-move",
        children: TOOL_WINDOW_ANCHORS.map((anchor) => ({
          label: TOOL_WINDOW_ANCHOR_LABELS[anchor],
          testId: `code-workspace-tool-rail-menu-move-${anchor}`,
          checked: item.anchor === anchor,
          onClick: () => onMove(item.id, anchor),
        })),
      });
    }
    if (onRemoveFromSidebar) {
      items.push({
        label: "Remove from Sidebar",
        testId: "code-workspace-tool-rail-menu-remove",
        onClick: () => onRemoveFromSidebar(item.id),
      });
    }
    if (onToggleShowNames) {
      items.push({ label: "", separator: true });
      items.push(namesItem);
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openStripeMenu = (event: ReactMouseEvent) => {
    if (!onToggleShowNames) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items: [namesItem] });
  };

  return (
    <nav
      aria-label={side === "left" ? "Left tool windows" : "Right tool windows"}
      data-testid={`code-workspace-tool-rail-${side}`}
      data-show-names={showNames || undefined}
      data-embedded={embedded || undefined}
      style={{ width: embedded ? "100%" : width }}
      className={embedded
        ? "taomni-tool-window-rail relative flex min-h-0 flex-1 shrink-0 flex-col items-stretch overflow-y-auto overflow-x-hidden border-t border-[var(--taomni-sidebar-border)] py-1"
        : `taomni-tool-window-rail relative flex h-full shrink-0 flex-col items-stretch overflow-y-auto overflow-x-hidden bg-[var(--taomni-code-gutter-bg)] py-1 ${side === "left"
          ? "border-r border-[var(--taomni-code-border)]"
          : "border-l border-[var(--taomni-code-border)]"}`}
      onContextMenu={openStripeMenu}
    >
      <div className="flex shrink-0 flex-col items-stretch gap-1 px-1">
        {top.map((item, index) => (
          <ToolWindowRailButtonSlot key={item.id} item={item} showNames={showNames} previous={top[index - 1]} onContextMenu={openButtonMenu} />
        ))}
      </div>
      <div className="min-h-2 flex-1" />
      <div className="flex shrink-0 flex-col items-stretch gap-1 px-1">
        {bottom.map((item) => (
          <ToolWindowRailButton key={item.id} item={item} showNames={showNames} onContextMenu={openButtonMenu} />
        ))}
        {bottomSlotRef && <div ref={bottomSlotRef} className="flex w-full flex-col items-stretch gap-1" />}
        {footer}
      </div>
      {showNames && onResize && !embedded && (
        <ToolWindowRailResizeHandle side={side} width={width} onResize={onResize} />
      )}
      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </nav>
  );
}

/** The containing rail owns resizing, including when tab tools are embedded. */
export function ToolWindowRailResizeHandle({
  side,
  width,
  onResize,
  minWidth = STRIPE_MIN_WIDTH,
  testId = `code-workspace-tool-rail-${side}-resize`,
}: {
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  testId?: string;
  minWidth?: number;
}) {
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const target = event.currentTarget;
    // preventDefault suppresses the focusing mousedown; keep keyboard resize.
    target.focus();
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      onResize(Math.max(minWidth, clampStripeWidth(width + delta)));
    };
    const finish = () => {
      dragCleanupRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    dragCleanupRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (event.key === grow || event.key === shrink) {
      event.preventDefault();
      onResize(Math.max(minWidth, clampStripeWidth(width + (event.key === grow ? 4 : -4))));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onResize(event.key === "Home" ? minWidth : STRIPE_MAX_WIDTH);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`Resize ${side} tool window bar`}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={STRIPE_MAX_WIDTH}
      data-testid={testId}
      className={`absolute inset-y-0 z-10 w-1.5 touch-none cursor-col-resize hover:bg-[var(--taomni-accent)]/60 focus:bg-[var(--taomni-accent)]/60 ${side === "left" ? "right-0" : "left-0"}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** Side windows docked at a secondary anchor sit after a separator (IDEA). */
function ToolWindowRailButtonSlot({
  item,
  previous,
  showNames,
  onContextMenu,
}: {
  item: ToolWindowRailItem;
  previous?: ToolWindowRailItem;
  showNames: boolean;
  onContextMenu: (event: ReactMouseEvent, item: ToolWindowRailItem) => void;
}) {
  const separated = !!previous
    && (previous.anchor === "left-top" || previous.anchor === "right-top")
    && (item.anchor === "left-bottom" || item.anchor === "right-bottom");
  return (
    <>
      {separated && <div role="separator" className="mx-1 my-0.5 h-px bg-[var(--taomni-code-border)]" />}
      <ToolWindowRailButton item={item} showNames={showNames} onContextMenu={onContextMenu} />
    </>
  );
}

export function ToolWindowRailButton({
  item,
  showNames = false,
  onClick,
  onContextMenu,
  onDoubleClick,
}: {
  item: ToolWindowRailItem;
  showNames?: boolean;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: ReactMouseEvent, item: ToolWindowRailItem) => void;
  onDoubleClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const title = [item.label, item.shortcut].filter(Boolean).join(" ")
    + (item.disabled && item.disabledReason ? ` — ${item.disabledReason}` : "");
  const showBadge = typeof item.badge === "number" ? item.badge > 0 : !!item.badge;
  return (
    <button
      type="button"
      role={item.testId?.startsWith("code-workspace-bottom-tab-") ? "tab" : undefined}
      data-testid={item.testId ?? `code-workspace-tool-rail-${item.id}`}
      data-tool-window-id={item.id}
      data-anchor={item.anchor}
      aria-pressed={item.active}
      aria-selected={item.testId?.startsWith("code-workspace-bottom-tab-") ? item.active : undefined}
      aria-label={item.label}
      data-active={item.active || undefined}
      disabled={item.disabled}
      title={title}
      className={toolWindowRailButtonClass}
      onClick={onClick ?? item.onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
    >
      <span aria-hidden="true" className="flex h-[20px] w-[20px] items-center justify-center [&>svg]:h-[16px] [&>svg]:w-[16px]">{item.icon}</span>
      {showNames && (
        <span className="w-full truncate px-0.5 text-center text-[10px] leading-[12px]">{item.label}</span>
      )}
      {showBadge && (
        <span className="absolute right-0.5 top-0.5 rounded bg-[var(--taomni-code-active-line-bg)] px-0.5 text-[8px] leading-3 tabular-nums text-[var(--taomni-code-text)]">
          {item.badge}
        </span>
      )}
    </button>
  );
}

export const toolWindowRailButtonClass = "relative flex min-h-[32px] w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-0 py-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--taomni-accent)] disabled:opacity-40 data-[active=true]:bg-[var(--taomni-accent)] data-[active=true]:text-white";

/**
 * IDEA "More tool windows" (…) at the end of the left stripe: every tool
 * window, including ones removed from the sidebar; picking one restores and
 * shows it.
 */
export function MoreToolWindowsButton({
  tools,
  onPick,
}: {
  tools: readonly { id: string; label: string; icon?: ReactNode }[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const rect = open ? buttonRef.current?.getBoundingClientRect() : null;
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="code-workspace-bottom-tab-overflow"
        aria-label="More tool windows"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More tool windows"
        className={toolWindowRailButtonClass}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-[16px] w-[16px]" />
      </button>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="More tool windows"
          data-testid="code-workspace-bottom-tab-overflow-menu"
          style={{ position: "fixed", left: rect.right + 4, bottom: Math.max(8, window.innerHeight - rect.bottom) }}
          className="z-50 min-w-48 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] py-1 shadow-lg"
        >
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitem"
              data-testid={`code-workspace-bottom-tab-overflow-${tool.id}`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
              onClick={() => {
                setOpen(false);
                onPick(tool.id);
              }}
            >
              <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{tool.icon}</span>
              <span className="flex-1 truncate text-left">{tool.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

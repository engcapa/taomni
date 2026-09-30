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
}: ToolWindowRailProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

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
    setMenu({ x: event.clientX, y: event.clientY, items: [namesItem] });
  };

  const resizable = showNames && !!onResize;
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    event.preventDefault();
    const target = event.currentTarget;
    // preventDefault suppresses the focusing mousedown; keep keyboard resize.
    target.focus();
    target.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    const onMovePointer = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = side === "left" ? moveEvent.clientX - drag.startX : drag.startX - moveEvent.clientX;
      onResize?.(clampStripeWidth(drag.startWidth + delta));
    };
    const finish = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!resizable) return;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (event.key === grow || event.key === shrink) {
      event.preventDefault();
      onResize?.(clampStripeWidth(width + (event.key === grow ? 4 : -4)));
    }
  };

  return (
    <nav
      aria-label={side === "left" ? "Left tool windows" : "Right tool windows"}
      data-testid={`code-workspace-tool-rail-${side}`}
      data-show-names={showNames || undefined}
      style={{ width }}
      className={`relative flex h-full shrink-0 flex-col items-stretch overflow-y-auto overflow-x-hidden bg-[var(--taomni-code-gutter-bg)] py-1 [scrollbar-width:none] ${side === "left"
        ? "border-r border-[var(--taomni-code-border)]"
        : "border-l border-[var(--taomni-code-border)]"}`}
      onContextMenu={openStripeMenu}
    >
      <div className="flex flex-col items-stretch gap-1 px-1">
        {top.map((item, index) => (
          <ToolWindowRailButtonSlot key={item.id} item={item} showNames={showNames} previous={top[index - 1]} onContextMenu={openButtonMenu} />
        ))}
      </div>
      <div className="min-h-2 flex-1" />
      <div className="flex flex-col items-stretch gap-1 px-1">
        {bottom.map((item) => (
          <ToolWindowRailButton key={item.id} item={item} showNames={showNames} onContextMenu={openButtonMenu} />
        ))}
        {bottomSlotRef && <div ref={bottomSlotRef} className="flex w-full flex-col items-stretch gap-1" />}
        {footer}
      </div>
      {resizable && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={`Resize ${side} tool window bar`}
          aria-valuenow={width}
          aria-valuemin={STRIPE_MIN_WIDTH}
          aria-valuemax={STRIPE_MAX_WIDTH}
          data-testid={`code-workspace-tool-rail-${side}-resize`}
          className={`absolute inset-y-0 z-10 w-1.5 cursor-col-resize hover:bg-[var(--taomni-accent)]/60 focus:bg-[var(--taomni-accent)]/60 ${side === "left" ? "right-0" : "left-0"}`}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      )}
      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </nav>
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
  onContextMenu,
}: {
  item: ToolWindowRailItem;
  showNames?: boolean;
  onContextMenu?: (event: ReactMouseEvent, item: ToolWindowRailItem) => void;
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
      onClick={item.onSelect}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
    >
      <span className="flex h-5 w-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>
      {showNames && (
        <span className="w-full truncate px-0.5 text-center text-[10px] leading-3">{item.label}</span>
      )}
      {showBadge && (
        <span className="absolute right-0.5 top-0.5 rounded bg-[var(--taomni-code-active-line-bg)] px-0.5 text-[8px] leading-3 tabular-nums text-[var(--taomni-code-text)]">
          {item.badge}
        </span>
      )}
    </button>
  );
}

export const toolWindowRailButtonClass = "relative flex min-h-8 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-0 py-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] disabled:opacity-40 data-[active=true]:bg-[var(--taomni-accent)] data-[active=true]:text-white";

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
        <MoreHorizontal className="h-4 w-4" />
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

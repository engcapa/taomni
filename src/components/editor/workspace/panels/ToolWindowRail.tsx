import type { ReactNode, Ref } from "react";

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
  onSelect: () => void;
}

interface ToolWindowRailProps {
  side: "left" | "right";
  top: readonly ToolWindowRailItem[];
  bottom?: readonly ToolWindowRailItem[];
  /** Host element for buttons rendered by another owner (the bottom dock). */
  bottomSlotRef?: Ref<HTMLDivElement>;
}

/**
 * IDEA tool window stripe (ED-PARITY-010 DEC-010-01): icon + truncated label
 * buttons along the workspace edge. Clicking shows the window, or hides it
 * when it is already the visible one. The rail spans the full workspace
 * height so side and bottom tool windows can be open at the same time.
 */
export function ToolWindowRail({ side, top, bottom = [], bottomSlotRef }: ToolWindowRailProps) {
  return (
    <nav
      aria-label={side === "left" ? "Left tool windows" : "Right tool windows"}
      data-testid={`code-workspace-tool-rail-${side}`}
      className={`flex h-full w-9 shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden bg-[var(--taomni-code-gutter-bg)] py-1 [scrollbar-width:none] ${side === "left"
        ? "border-r border-[var(--taomni-code-border)]"
        : "border-l border-[var(--taomni-code-border)]"}`}
    >
      {top.map((item) => <ToolWindowRailButton key={item.id} item={item} />)}
      <div className="min-h-2 flex-1" />
      {bottom.map((item) => <ToolWindowRailButton key={item.id} item={item} />)}
      {bottomSlotRef && <div ref={bottomSlotRef} className="flex w-full flex-col items-center gap-0.5" />}
    </nav>
  );
}

export function ToolWindowRailButton({ item }: { item: ToolWindowRailItem }) {
  const title = [item.label, item.shortcut].filter(Boolean).join(" ")
    + (item.disabled && item.disabledReason ? ` — ${item.disabledReason}` : "");
  return (
    <button
      type="button"
      data-testid={item.testId ?? `code-workspace-tool-rail-${item.id}`}
      aria-pressed={item.active}
      aria-label={item.label}
      data-active={item.active || undefined}
      disabled={item.disabled}
      title={title}
      className={toolWindowRailButtonClass}
      onClick={item.onSelect}
    >
      {item.icon}
      <span className="w-full truncate px-0.5 text-center text-[9px] leading-3">{item.label}</span>
    </button>
  );
}

export const toolWindowRailButtonClass = "flex w-8 shrink-0 flex-col items-center gap-0.5 rounded px-0 py-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] disabled:opacity-40 data-[active=true]:bg-[var(--taomni-accent)] data-[active=true]:text-white";

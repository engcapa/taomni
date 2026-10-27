import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, SplitSquareVertical, Users } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { useViewportSize } from "../../hooks/useViewportSize";
import { useToolbarPopover } from "../tabbar/useToolbarPopover";

interface TitleBarTrayProps {
  compact?: boolean;
  layoutActions?: boolean;
  children?: ReactNode;
  slotRef?: (element: HTMLDivElement | null) => void;
  visible?: boolean;
  contextKey?: string;
}

/** Shared overflow for mode actions and the active tab's contextual controls. */
export function TitleBarTrayControls({ compact = false, layoutActions = true, children,
  slotRef, visible = true, contextKey }: TitleBarTrayProps = {}) {
  const split = useAppStore((s) => s.terminalSplitActive);
  const multiExec = useAppStore((s) => s.multiExecActive);
  const toggleSplit = useAppStore((s) => s.toggleTerminalSplit);
  const toggleMultiExec = useAppStore((s) => s.toggleMultiExec);
  const t = useT();
  const { width } = useViewportSize();
  const actions = <>
    {layoutActions && <>
      <ToolbarMenuAction testId="tab-split-view" title={t(split ? "titlebar.disableSplit" : "titlebar.enableSplit")}
        active={split} onClick={toggleSplit} icon={<SplitSquareVertical />} />
      <ToolbarMenuAction testId="tab-multiexec-toggle" title={t(multiExec ? "titlebar.disableMultiExec" : "titlebar.enableMultiExec")}
        active={multiExec} onClick={toggleMultiExec} icon={<Users />} />
    </>}
    {children}
  </>;
  if (!compact && width > 960) return <div className="taomni-titlebar-tray flex items-center self-stretch shrink-0" data-testid="titlebar-tray">{actions}</div>;
  return <TitleBarOverflow visible={visible} contextKey={contextKey} slotRef={slotRef}>{actions}</TitleBarOverflow>;
}

function TitleBarOverflow({ children, slotRef, visible, contextKey }: {
  children: ReactNode; slotRef?: (element: HTMLDivElement | null) => void; visible: boolean; contextKey?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const expanded = open && visible;
  const position = useToolbarPopover(expanded, close, anchorRef, menuRef);
  useEffect(() => { close(); }, [contextKey, visible, close]);
  useEffect(() => {
    if (expanded) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [expanded]);

  return <>
    <div ref={anchorRef} className="relative flex items-center self-stretch shrink-0" hidden={!visible}>
      {visible && <button type="button" data-testid="titlebar-actions-more"
        title={t("titlebar.moreActions")} aria-label={t("titlebar.moreActions")} aria-haspopup="menu" aria-expanded={expanded}
        className="taomni-platform-toolbar-button" onClick={() => setOpen((value) => !value)}><MoreHorizontal className="h-4 w-4" /></button>}
    </div>
    {createPortal(<div ref={menuRef} data-testid="titlebar-actions-menu" data-taomni-context-menu="" role="menu"
      aria-label={t("titlebar.moreActions")} hidden={!expanded}
      className="taomni-titlebar-actions-menu fixed z-[9999] w-64 max-w-[calc(100vw-16px)] max-h-[75vh] overflow-y-auto rounded-lg border p-1 shadow-xl"
      style={{ ...position, display: expanded ? undefined : "none", background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
      onClick={(event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button");
        if (!button || button.disabled || button.hasAttribute("aria-haspopup")) return;
        const returnFocus = menuRef.current?.contains(document.activeElement);
        close();
        if (returnFocus) anchorRef.current?.querySelector("button")?.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {children}
      {/* Keep the portal destination mounted while the menu is closed. Closing
          the menu never changes ownership of a session or its live controls. */}
      <div ref={slotRef} data-testid="tab-action-slot" data-presentation="menu" className="taomni-tab-action-menu-slot flex flex-col" />
    </div>, document.body)}
  </>;
}

export function ToolbarMenuAction({ testId, title, icon, active, onClick, disabled }: {
  testId: string; title: string; icon: ReactNode; active?: boolean; onClick: () => void; disabled?: boolean;
}) {
  return <button type="button" role={active === undefined ? "menuitem" : "menuitemcheckbox"}
    data-testid={testId} title={title} aria-label={title} aria-checked={active} data-active={active || undefined}
    disabled={disabled} onClick={onClick}
    className="taomni-toolbar-menu-action flex min-h-7 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-[var(--taomni-hover)] disabled:opacity-40 data-[active=true]:text-[var(--taomni-accent)]">
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{title}</span>
    {active && <span aria-hidden="true">✓</span>}
  </button>;
}

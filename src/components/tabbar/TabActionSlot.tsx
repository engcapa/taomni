import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Per-tab action toolbar plumbing.
 *
 * The actions for the active tab (Capture / SFTP / Chat / Detach / Maximize /
 * Reconnect / Scale …) used to float over the tab content via `FloatingToolbar`.
 * They now render into a fixed slot inside the unified ControlBar (and inside a
 * detached window's own bar). Each window root provides its own slot DOM node;
 * panels portal their buttons into it while they are the active tab.
 */
const TabActionSlotContext = createContext<HTMLElement | null>(null);

export function TabActionSlotProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  return <TabActionSlotContext.Provider value={slot}>{children}</TabActionSlotContext.Provider>;
}

export function useTabActionSlot(): HTMLElement | null {
  return useContext(TabActionSlotContext);
}

/**
 * Renders `children` into the active window's tab-action slot when `active` is
 * true. Returns nothing when the tab is inactive or no slot is mounted (e.g. a
 * tab type that has no contextual actions, or a render before the bar mounts).
 */
export function TabActions({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const slot = useTabActionSlot();
  if (!active || !slot) return null;
  return createPortal(children, slot);
}

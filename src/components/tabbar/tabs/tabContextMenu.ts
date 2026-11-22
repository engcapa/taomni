import { createElement, type ReactNode } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Pencil,
  Pin,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { MenuItem } from "../../ContextMenu";

/** Same 12px icon box the Sessions tab menu has always used. */
const MENU_ICON = "w-3 h-3";

// The builder is a `.ts` module (no JSX) so both tab strips can share it
// without dragging React component files into the tab state modules.
function menuIcon(icon: LucideIcon): ReactNode {
  return createElement(icon, { className: MENU_ICON });
}

export interface TabContextMenuLabels {
  close: string;
  closeOthers: string;
  closeAll: string;
  rename: string;
  duplicate: string;
  copyPath: string;
  moveToFirst: string;
  moveLeft: string;
  moveRight: string;
  moveToLast: string;
  /** Explorer-only items. Sessions does not render them (`pinAndBulkClose`). */
  pin?: string;
  unpin?: string;
  closeLeft?: string;
  closeRight?: string;
  closeUnmodified?: string;
  closeUnpinned?: string;
}

export interface TabContextMenuActions {
  close: () => void;
  closeOthers: () => void;
  closeAll: () => void;
  rename: () => void;
  duplicate: () => void;
  copyPath: () => void;
  moveToFirst: () => void;
  moveLeft: () => void;
  moveRight: () => void;
  moveToLast: () => void;
  /** Explorer-only actions. Sessions does not render them. */
  togglePin?: () => void;
  closeLeft?: () => void;
  closeRight?: () => void;
  closeUnmodified?: () => void;
  closeUnpinned?: () => void;
}

export interface TabContextMenuState {
  closable: boolean;
  canRename: boolean;
  canDuplicate: boolean;
  pinned: boolean;
  first: boolean;
  last: boolean;
}

export type TabContextMenuKey =
  | "close"
  | "close-others"
  | "close-all"
  | "rename"
  | "duplicate"
  | "copy-path"
  | "move-first"
  | "move-left"
  | "move-right"
  | "move-last"
  | "pin"
  | "close-left"
  | "close-right"
  | "close-unmodified"
  | "close-unpinned";

export interface TabContextMenuOptions {
  labels: TabContextMenuLabels;
  actions: TabContextMenuActions;
  state: TabContextMenuState;
  /**
   * Explicit per-item test id. Returning `undefined` keeps the menu surface's
   * label-derived fallback, which Sessions depends on for its existing
   * `context-menu-item-<label>` anchors.
   */
  testIdFor?: (key: TabContextMenuKey) => string | undefined;
  /** Explorer renders pin + bulk-close items after the move block. */
  pinAndBulkClose?: boolean;
}

/**
 * One ordering for every tab strip's context menu (U4): Sessions and Explorer
 * share labels/icons/separators and only differ in their extra items and test
 * ids. Callers own the tab-specific state and actions.
 */
export function buildTabContextMenu(options: TabContextMenuOptions): MenuItem[] {
  const { labels, actions, state, testIdFor, pinAndBulkClose = false } = options;
  const testId = (key: TabContextMenuKey) => testIdFor?.(key);
  const items: MenuItem[] = [
    { label: labels.close, testId: testId("close"), icon: menuIcon(X), onClick: actions.close, disabled: !state.closable },
    { label: labels.closeOthers, testId: testId("close-others"), icon: menuIcon(Trash2), onClick: actions.closeOthers },
    { label: labels.closeAll, testId: testId("close-all"), icon: menuIcon(Trash2), onClick: actions.closeAll },
    { label: "", separator: true },
    { label: labels.rename, testId: testId("rename"), icon: menuIcon(Pencil), onClick: actions.rename, disabled: !state.canRename },
    { label: labels.duplicate, testId: testId("duplicate"), icon: menuIcon(Copy), onClick: actions.duplicate, disabled: !state.canDuplicate },
    { label: labels.copyPath, testId: testId("copy-path"), icon: menuIcon(ClipboardCopy), onClick: actions.copyPath },
    { label: "", separator: true },
    { label: labels.moveToFirst, testId: testId("move-first"), icon: menuIcon(ChevronFirst), onClick: actions.moveToFirst, disabled: state.first },
    { label: labels.moveLeft, testId: testId("move-left"), icon: menuIcon(ChevronLeft), onClick: actions.moveLeft, disabled: state.first },
    { label: labels.moveRight, testId: testId("move-right"), icon: menuIcon(ChevronRight), onClick: actions.moveRight, disabled: state.last },
    { label: labels.moveToLast, testId: testId("move-last"), icon: menuIcon(ChevronLast), onClick: actions.moveToLast, disabled: state.last },
  ];
  if (!pinAndBulkClose) return items;
  return [
    ...items,
    { label: "", separator: true },
    { label: state.pinned ? labels.unpin ?? "" : labels.pin ?? "", testId: testId("pin"), icon: menuIcon(Pin), onClick: actions.togglePin },
    { label: labels.closeLeft ?? "", testId: testId("close-left"), icon: menuIcon(Trash2), onClick: actions.closeLeft, disabled: state.first },
    { label: labels.closeRight ?? "", testId: testId("close-right"), icon: menuIcon(Trash2), onClick: actions.closeRight, disabled: state.last },
    { label: labels.closeUnmodified ?? "", testId: testId("close-unmodified"), icon: menuIcon(Trash2), onClick: actions.closeUnmodified },
    { label: labels.closeUnpinned ?? "", testId: testId("close-unpinned"), icon: menuIcon(Trash2), onClick: actions.closeUnpinned },
  ];
}

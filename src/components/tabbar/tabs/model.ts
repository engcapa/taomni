import { type TranslateFn } from "../../../lib/i18n";
import { type SessionConfig } from "../../../lib/ipc";
import type { LocalShellSelection, Tab } from "../../../types";

export type DropIndicator = { tabId: string; side: "before" | "after"; } | null;

export type TabScrollState = { overflow: boolean; atStart: boolean; atEnd: boolean; };

export interface TabBarProps {
  onStartLocalTerminal: (localShell?: LocalShellSelection) => void;
  onConnectSession: (session: SessionConfig) => void;
  onOpenSessionEditor: () => void;
  /**
   * Optional override for the "Duplicate tab" action. MainLayout supplies this
   * so a duplicated local/SSH terminal can first resolve the source terminal's
   * current directory and open the copy there. Falls back to the plain store
   * action (no cwd handling) when not provided.
   */
  onDuplicateTab?: (id: string) => void;
  /** External hover/focus trigger from the title-bar details button. */
  detailsRevealExternal?: boolean;
}

export interface TabItemProps {
  tab: Tab;
  translate: TranslateFn;
  active: boolean;
  multiExecActive: boolean;
  multiExecSelected: boolean;
  dragging: boolean;
  draggedId: string | null;
  dropSide: "before" | "after" | undefined;
  editing: boolean;
  draftTitle: string;
  onElementChange: (id: string, node: HTMLDivElement | null) => void;
  onStartDrag: (e: React.PointerEvent<HTMLDivElement>, tab: Tab, el: HTMLDivElement) => void;
  onDragOverTab: (tab: Tab, rect: DOMRect, clientX: number) => void;
  onDragLeaveTab: (tab: Tab) => void;
  onDropOnTab: (tab: Tab, rect: DOMRect, clientX: number) => void;
  onActivate: (tab: Tab) => void;
  onMouseDown: (e: React.MouseEvent, tab: Tab) => void;
  onContextMenu: (e: React.MouseEvent, tab: Tab) => void;
  onDraftTitleChange: (next: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (tab: Tab) => void;
  onShowDetails: (id: string) => void;
  onHideDetails: (id: string) => void;
  onToggleMultiExecTab: (id: string) => void;
  onRemove: (id: string) => void;
}

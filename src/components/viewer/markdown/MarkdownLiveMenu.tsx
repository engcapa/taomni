import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Copy, TextSelect } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import { ContextMenu, type ContextMenuCloseReason } from "../../ContextMenu";
import { useViewerLabels } from "../viewerLabels";
import { loadedMarkdownImage, MARKDOWN_DIAGRAM_SELECTOR } from "./diagramModel";

interface SelectionSnapshot {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

interface LiveMenuState {
  x: number;
  y: number;
  text: string;
  surface: HTMLElement;
  /** DOM boundary points captured at the right click, before the menu takes focus. */
  ranges: SelectionSnapshot[];
}

function ownsTarget(surface: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Element && surface.contains(target)
    && !target.closest(`button,input,textarea,select,[contenteditable="true"],${MARKDOWN_DIAGRAM_SELECTOR}`)
    && !loadedMarkdownImage(target);
}

function selectedText(surface: HTMLElement): string {
  const selection = surface.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !surface.contains(selection.anchorNode)
    || !surface.contains(selection.focusNode)) return "";
  return selection.toString();
}

function selectedRanges(surface: HTMLElement): SelectionSnapshot[] {
  const selection = surface.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount
    || !surface.contains(selection.anchorNode) || !surface.contains(selection.focusNode)) return [];
  const ranges: SelectionSnapshot[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    ranges.push({
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    });
  }
  return ranges;
}

function nodeLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE
    ? (node as Text).data.length
    : node.childNodes.length;
}

function snapshotRange(snapshot: SelectionSnapshot): Range | null {
  const { startContainer, endContainer } = snapshot;
  if (!startContainer.isConnected || !endContainer.isConnected) return null;
  try {
    const range = startContainer.ownerDocument!.createRange();
    range.setStart(startContainer, Math.min(snapshot.startOffset, nodeLength(startContainer)));
    range.setEnd(endContainer, Math.min(snapshot.endOffset, nodeLength(endContainer)));
    return range;
  } catch {
    return null;
  }
}

/**
 * Re-apply the DOM ranges captured when the menu opened.
 *
 * WebKit (WKWebView, WebKitGTK) collapses the document selection the moment
 * the menu moves focus into itself. The copied text stays correct because the
 * menu captured it first, but the visible selection disappears — in Source
 * mode the editor paints its own drawSelection layer, so only Live browse is
 * affected. Chromium keeps the native range; there, and whenever the user
 * already made a new selection, leave the live selection alone.
 */
function restoreSelection(surface: HTMLElement, snapshots: SelectionSnapshot[], expectedText: string): boolean {
  if (!snapshots.length) return false;
  const selection = surface.ownerDocument.getSelection();
  if (!selection || (!selection.isCollapsed && selection.rangeCount > 0)) return false;
  const usable = snapshots
    .filter((snapshot) => surface.contains(snapshot.startContainer) && surface.contains(snapshot.endContainer))
    .map(snapshotRange)
    .filter((range): range is Range => range !== null);
  if (!usable.length) return false;
  selection.removeAllRanges();
  for (const range of usable) selection.addRange(range);
  // Never install a range whose text differs from what the menu will copy.
  if (selection.toString() !== expectedText) {
    selection.removeAllRanges();
    return false;
  }
  return true;
}

/**
 * Re-apply captured boundary points across the focus/selection task boundaries
 * WebKit uses when the context menu takes focus. Bounded retries only: a
 * restore is a no-op once a non-empty selection exists, and detached ranges
 * are ignored.
 */
function scheduleRangeRestore(surface: HTMLElement, snapshots: SelectionSnapshot[], text: string): void {
  for (const delay of [0, 50, 150]) {
    window.setTimeout(() => { restoreSelection(surface, snapshots, text); }, delay);
  }
}

export function MarkdownLiveMenu({ root, enabled, onError }: {
  root: RefObject<HTMLDivElement | null>; enabled: boolean; onError: (message: string) => void;
}) {
  const label = useViewerLabels();
  const [menu, setMenu] = useState<LiveMenuState | null>(null);
  const menuRef = useRef<LiveMenuState | null>(null);
  menuRef.current = menu;
  // "Select all" replaces the range on purpose; do not re-apply the old one.
  const skipRestoreRef = useRef(false);

  const closeMenu = useCallback((reason?: ContextMenuCloseReason) => {
    const previous = menuRef.current;
    menuRef.current = null;
    setMenu(null);
    const restore = Boolean(previous && previous.ranges.length && !skipRestoreRef.current && reason !== "outside");
    skipRestoreRef.current = false;
    if (!previous || !restore) return;
    const { surface, ranges, text } = previous;
    // MenuSurface returns focus on unmount in a microtask and WebKit may
    // deliver the resulting selection clearing in a later task, so retry a few
    // bounded times instead of assuming one ordering.
    scheduleRangeRestore(surface, ranges, text);
  }, []);

  useEffect(() => {
    const surface = root.current?.querySelector<HTMLElement>(".fv-md-live-surface .cm-content");
    if (!enabled || !surface) return;
    const open = (event: MouseEvent | KeyboardEvent, x: number, y: number) => {
      if (!ownsTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      skipRestoreRef.current = false;
      setMenu({ x, y, surface, text: selectedText(surface), ranges: selectedRanges(surface) });
    };
    const context = (event: MouseEvent) => open(event, event.clientX, event.clientY);
    const preserve = (event: MouseEvent) => {
      if (event.button === 2 && ownsTarget(surface, event.target) && selectedText(surface)) event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const selection = surface.ownerDocument.getSelection();
      const bounds = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect?.() : null;
      const box = bounds?.width ? bounds : surface.getBoundingClientRect();
      open(event, box.left + 12, box.top + 12);
    };
    const dismiss = (reason: ContextMenuCloseReason) => closeMenu(reason);
    const outside = (event: Event) => {
      if (event.target instanceof Element && !event.target.closest('[data-testid="markdown-live-context-menu"]')) dismiss("outside");
    };
    surface.addEventListener("mousedown", preserve, true);
    surface.addEventListener("contextmenu", context);
    surface.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside, true);
    const appBlur = () => dismiss("programmatic");
    window.addEventListener("blur", appBlur);
    return () => {
      surface.removeEventListener("mousedown", preserve, true);
      surface.removeEventListener("contextmenu", context);
      surface.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", appBlur);
      setMenu(null);
    };
  }, [root, enabled, closeMenu]);

  // The menu focuses itself right after mounting. Re-apply the captured range
  // a few bounded times and whenever the engine reports the selection was
  // cleared while the menu owns focus, so the highlight survives independent
  // of the focus/selection ordering (WebKit clears it after focusing the menu;
  // Chromium keeps it and the restore is then a no-op).
  useEffect(() => {
    if (!menu?.ranges.length) return undefined;
    const { surface, ranges, text } = menu;
    const restoreIfCleared = () => {
      if (skipRestoreRef.current || !menuRef.current) return;
      const selection = surface.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) return;
      // Restore immediately (the menu focus may already have cleared the range)
      // and keep bounded retries for engines that clear it in a later task.
      restoreSelection(surface, ranges, text);
      scheduleRangeRestore(surface, ranges, text);
    };
    const frame = window.requestAnimationFrame(restoreIfCleared);
    const timers = [0, 50, 150].map((delay) => window.setTimeout(restoreIfCleared, delay));
    surface.ownerDocument.addEventListener("selectionchange", restoreIfCleared);
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      surface.ownerDocument.removeEventListener("selectionchange", restoreIfCleared);
    };
  }, [menu]);

  if (!enabled || !menu?.surface.isConnected) return null;
  return <ContextMenu x={menu.x} y={menu.y} testId="markdown-live-context-menu" onClose={closeMenu} items={[
    { testId: "markdown-live-copy-selection", label: label("复制", "Copy"), icon: <Copy size={14} />, disabled: !menu.text,
      onClick: () => void writeText(menu.text).catch((error: unknown) => onError(String(error))) },
    { testId: "markdown-live-select-all", label: label("全选", "Select all"), icon: <TextSelect size={14} />, onClick: () => {
      skipRestoreRef.current = true;
      menu.surface.focus({ preventScroll: true });
      const range = menu.surface.ownerDocument.createRange();
      range.selectNodeContents(menu.surface);
      const selection = menu.surface.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } },
  ]} />;
}

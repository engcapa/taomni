import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Copy, TextSelect } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import { ContextMenu, type ContextMenuCloseReason } from "../../ContextMenu";
import { useViewerLabels } from "../viewerLabels";
import { loadedMarkdownImage, MARKDOWN_DIAGRAM_SELECTOR } from "./diagramModel";

interface LiveMenuState {
  x: number;
  y: number;
  text: string;
  surface: HTMLElement;
  /** Cloned DOM ranges captured at the right click, before the menu takes focus. */
  ranges: Range[];
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

function selectedRanges(surface: HTMLElement): Range[] {
  const selection = surface.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount
    || !surface.contains(selection.anchorNode) || !surface.contains(selection.focusNode)) return [];
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange());
  }
  return ranges;
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
function restoreSelection(surface: HTMLElement, ranges: Range[], expectedText: string): boolean {
  if (!ranges.length) return false;
  const selection = surface.ownerDocument.getSelection();
  if (!selection || (!selection.isCollapsed && selection.rangeCount > 0)) return false;
  const usable = ranges.filter((range) => range.startContainer.isConnected
    && range.endContainer.isConnected
    && surface.contains(range.startContainer) && surface.contains(range.endContainer));
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
    // MenuSurface returns focus on unmount in a microtask; run after it so the
    // focus move cannot clear the range again while the menu is closing.
    window.setTimeout(() => { restoreSelection(surface, ranges, text); }, 0);
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

  // The menu focuses itself right after mounting. Re-apply the captured ranges
  // once its focus effect has run (and once more after the engine's selection
  // change task) so the highlight survives while the menu stays open.
  useEffect(() => {
    if (!menu?.ranges.length) return undefined;
    const { surface, ranges, text } = menu;
    const restore = () => { restoreSelection(surface, ranges, text); };
    const frame = window.requestAnimationFrame(restore);
    const timer = window.setTimeout(restore, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
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

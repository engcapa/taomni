import { useEffect, useState, type RefObject } from "react";
import { Copy, TextSelect } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import { ContextMenu } from "../../ContextMenu";
import { useViewerLabels } from "../viewerLabels";
import { loadedMarkdownImage, MARKDOWN_DIAGRAM_SELECTOR } from "./diagramModel";

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

export function MarkdownLiveMenu({ root, enabled, onError }: {
  root: RefObject<HTMLDivElement | null>; enabled: boolean; onError: (message: string) => void;
}) {
  const label = useViewerLabels();
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; surface: HTMLElement } | null>(null);
  useEffect(() => {
    const surface = root.current?.querySelector<HTMLElement>(".fv-md-live-surface .cm-content");
    if (!enabled || !surface) return;
    const open = (event: MouseEvent | KeyboardEvent, x: number, y: number) => {
      if (!ownsTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x, y, surface, text: selectedText(surface) });
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
    const dismiss = () => setMenu(null);
    const outside = (event: Event) => {
      if (event.target instanceof Element && !event.target.closest('[data-testid="markdown-live-context-menu"]')) dismiss();
    };
    surface.addEventListener("mousedown", preserve, true);
    surface.addEventListener("contextmenu", context);
    surface.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", dismiss);
    return () => {
      surface.removeEventListener("mousedown", preserve, true);
      surface.removeEventListener("contextmenu", context);
      surface.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", dismiss);
      setMenu(null);
    };
  }, [root, enabled]);
  if (!enabled || !menu?.surface.isConnected) return null;
  return <ContextMenu x={menu.x} y={menu.y} testId="markdown-live-context-menu" onClose={() => setMenu(null)} items={[
    { testId: "markdown-live-copy-selection", label: label("复制", "Copy"), icon: <Copy size={14} />, disabled: !menu.text,
      onClick: () => void writeText(menu.text).catch((error: unknown) => onError(String(error))) },
    { testId: "markdown-live-select-all", label: label("全选", "Select all"), icon: <TextSelect size={14} />, onClick: () => {
      menu.surface.focus({ preventScroll: true });
      const range = menu.surface.ownerDocument.createRange();
      range.selectNodeContents(menu.surface);
      const selection = menu.surface.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } },
  ]} />;
}

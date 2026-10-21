import { type MutableRefObject } from "react";
import { type Extension, type Text } from "@codemirror/state";
import { hoverDocTooltip } from "../hoverDocTooltip";
import { EditorView, hoverTooltip, keymap, tooltips, type Tooltip } from "@codemirror/view";
import { openExternalDocumentation, referenceHrefFromEventTarget, validateExternalDocUrl, type QuickDocContent } from "../referenceDocumentation";
import { startWindowResizeSession, type ResizeCorner, type WindowResizeSession } from "../windowResizeSession";
import { renderFormatted } from "../../../../lib/chat/renderFormatted";
import type { LspPosition, LspSignatureInfo } from "../../../../lib/editor/lsp";
import { createLspHyperlinkExtension } from "../lspHyperlink";
import { lspPositionFromOffset } from "../lspPositions";
import { detectLineFoldProvenance } from "../workspaceEditorCommands";


export function extractIdentifierAtPos(doc: Text, pos: number): string {
  if (pos < 0 || pos > doc.length) return "Documentation";
  const line = doc.lineAt(pos);
  const col = pos - line.from;
  const left = line.text.slice(0, col);
  const right = line.text.slice(col);
  const start = left.search(/[A-Za-z0-9_$]+$/);
  const endMatch = right.match(/^[A-Za-z0-9_$]*/);
  const from = start >= 0 ? start : col;
  const to = col + (endMatch?.[0].length ?? 0);
  const word = line.text.slice(from, to).trim();
  return word || "Documentation";
}


export function cancelActiveHoverResize(
  activeSessionRef: MutableRefObject<WindowResizeSession | null>,
): void {
  activeSessionRef.current?.dispose();
  activeSessionRef.current = null;
}


export function setupHoverResize(
  container: HTMLElement,
  handle: HTMLElement,
  activeSessionRef: MutableRefObject<WindowResizeSession | null>,
  corner: ResizeCorner = "se",
) {
  handle.onmousedown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveHoverResize(activeSessionRef);
    const startRect = container.getBoundingClientRect();
    const session = startWindowResizeSession({
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: startRect.width > 0 ? startRect.width : 440,
      startHeight: startRect.height > 0 ? startRect.height : 280,
      minWidth: 260,
      minHeight: 100,
      maxWidth: () => window.innerWidth > 0 ? window.innerWidth * 0.85 : 1200,
      maxHeight: () => window.innerHeight > 0 ? window.innerHeight * 0.75 : 800,
      onResize: (width, height) => {
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
      },
      onDispose: () => {
        if (activeSessionRef.current === session) activeSessionRef.current = null;
      },
    });
    activeSessionRef.current = session;
  };
}


export function createHoverDocDom({
  content,
  onPin,
  onClose,
  activeResizeSessionRef,
}: {
  content: QuickDocContent;
  onPin?: (content: QuickDocContent) => void;
  onClose?: () => void;
  activeResizeSessionRef: MutableRefObject<WindowResizeSession | null>;
}): HTMLElement {
  const container = document.createElement("div");
  container.className = "cm-lsp-hover-container relative flex flex-col overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-xl outline-none select-text";
  container.tabIndex = 0;
  container.setAttribute("role", "dialog");
  container.setAttribute("aria-label", "Hover documentation");
  container.setAttribute("data-testid", "code-workspace-hover-doc");

  // Header bar matching QuickDocPopup
  const header = document.createElement("div");
  header.className = "flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2 select-none bg-[var(--taomni-code-tooltip-bg)]";

  const titleSpan = document.createElement("span");
  titleSpan.className = "min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--taomni-code-text)]";
  titleSpan.textContent = content.title;
  header.appendChild(titleSpan);

  if (onPin) {
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.title = "Pin to Documentation pane";
    pinBtn.setAttribute("aria-label", "Pin to Documentation pane");
    pinBtn.setAttribute("data-testid", "code-workspace-hover-doc-pin");
    pinBtn.className = "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]";
    pinBtn.innerHTML = `<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
    pinBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPin(content);
      onClose?.();
    };
    header.appendChild(pinBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close quick documentation");
  closeBtn.className = "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]";
  closeBtn.innerHTML = `<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  closeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClose?.();
  };
  header.appendChild(closeBtn);

  container.appendChild(header);

  // Markdown body
  const body = document.createElement("div");
  body.className = "cm-lsp-hover taomni-chat-md min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--taomni-code-text)]";
  body.innerHTML = renderFormatted(content.body, "md") ?? "";
  body.onclick = (event) => {
    const href = referenceHrefFromEventTarget(event.target);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternalDocumentation(href);
  };
  container.appendChild(body);

  if (content.source || content.links?.length) {
    const footer = document.createElement("div");
    footer.className = "flex min-h-7 shrink-0 items-center gap-2 border-t border-[var(--taomni-code-border)] px-2 py-1 text-[10px] text-[var(--taomni-code-muted)]";
    const source = document.createElement("span");
    source.className = "min-w-0 flex-1 truncate";
    source.textContent = content.source;
    source.title = content.uri ?? content.source;
    footer.appendChild(source);
    for (const link of content.links ?? []) {
      const decision = validateExternalDocUrl(link.url);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = link.label;
      button.setAttribute("aria-label", `Open external documentation: ${link.label}`);
      button.disabled = decision.kind !== "allowed";
      button.title = decision.kind === "allowed"
        ? `${link.label} (${new URL(decision.url).host})`
        : `External Documentation unavailable (${decision.reason})`;
      button.className = "shrink-0 rounded px-1.5 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40";
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternalDocumentation(link.url);
      };
      footer.appendChild(button);
    }
    container.appendChild(footer);
  }

  // 4-corner resize handles
  const gripNW = document.createElement("div");
  gripNW.className = "absolute top-0 left-0 h-4 w-4 cursor-nw-resize z-10 select-none";
  setupHoverResize(container, gripNW, activeResizeSessionRef, "nw");
  container.appendChild(gripNW);

  const gripNE = document.createElement("div");
  gripNE.className = "absolute top-0 right-0 h-4 w-4 cursor-ne-resize z-10 select-none";
  setupHoverResize(container, gripNE, activeResizeSessionRef, "ne");
  container.appendChild(gripNE);

  const gripSW = document.createElement("div");
  gripSW.className = "absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize z-10 select-none";
  setupHoverResize(container, gripSW, activeResizeSessionRef, "sw");
  container.appendChild(gripSW);

  const gripSE = document.createElement("div");
  gripSE.setAttribute("data-testid", "code-workspace-hover-doc-resize-handle");
  gripSE.setAttribute("aria-label", "Resize hover documentation");
  gripSE.className = "absolute bottom-0 right-0 h-4 w-4 cursor-se-resize flex items-end justify-end p-0.5 opacity-40 hover:opacity-100 select-none z-10";
  gripSE.innerHTML = `<svg viewBox="0 0 6 6" class="h-2.5 w-2.5 fill-current text-[var(--taomni-code-muted)]"><path d="M5 1L1 5M5 3L3 5M5 5L5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
  setupHoverResize(container, gripSE, activeResizeSessionRef, "se");
  container.appendChild(gripSE);

  return container;
}


/**
 * Pure renderer for the Parameter Info tooltip (§8.20.2 W1: display only —
 * it never issues requests and holds no request sequence).
 */
export function signatureTooltipDom(
  result: {
    signatures: readonly LspSignatureInfo[];
    activeSignature: number;
    activeParameter: number;
  },
  showFullSignatures: boolean,
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Parameter info");
  dom.setAttribute("data-testid", "code-workspace-parameter-info");
  const active = Math.min(result.activeSignature, Math.max(0, result.signatures.length - 1));
  const indices = showFullSignatures
    ? result.signatures.map((_signature, index) => index)
    : [active];

  for (const index of indices) {
    const signature = result.signatures[index];
    if (!signature) continue;
    const section = document.createElement("div");
    section.setAttribute("data-signature-index", String(index));
    section.className = index === active ? "cm-signature-active" : "cm-signature-overload";
    if (index > 0 && showFullSignatures) section.style.marginTop = "8px";
    if (index !== active) section.style.opacity = "0.7";

    const label = document.createElement("div");
    label.style.fontFamily = "var(--taomni-code-font-family, monospace)";
    label.style.whiteSpace = "pre-wrap";
    const parameterIndex = signature.activeParameter ?? result.activeParameter;
    const parameter = signature.parameters[parameterIndex];
    const start = parameter?.labelStart
      ?? (parameter ? signature.label.indexOf(parameter.label) : -1);
    const end = parameter?.labelEnd
      ?? (parameter && start >= 0 ? start + parameter.label.length : -1);
    if (parameter && start >= 0 && end > start) {
      label.append(signature.label.slice(0, start));
      const bold = document.createElement("b");
      bold.textContent = signature.label.slice(start, end);
      label.append(bold, signature.label.slice(end));
    } else {
      label.textContent = signature.label;
    }
    section.appendChild(label);

    const documentation = parameter?.documentation ?? signature.documentation;
    if (documentation && (index === active || showFullSignatures)) {
      const doc = document.createElement("div");
      doc.style.marginTop = "6px";
      doc.innerHTML = renderFormatted(documentation, "md") ?? "";
      section.appendChild(doc);
    }
    dom.appendChild(section);
  }

  if (result.signatures.length > 1) {
    const counter = document.createElement("div");
    counter.style.opacity = "0.6";
    counter.style.fontSize = "11px";
    counter.style.marginTop = "6px";
    counter.textContent = showFullSignatures
      ? `${result.signatures.length} overloads`
      : `${active + 1}/${result.signatures.length} overloads`;
    dom.appendChild(counter);
  }
  return dom;
}


export function lspNavigationExtensions(
  definitionRef: MutableRefObject<(position: LspPosition) => Promise<boolean>>,
  referencesRef: MutableRefObject<(position: LspPosition) => Promise<void>>,
  hasActionHost: () => boolean = () => false,
): Extension[] {
  const definitionAtSelection = (view: EditorView) => {
    // ED-PARITY-013 DEC-013-11: with a workspace action host these keys are
    // host-owned (F12 = Jump to Last Tool Window, Ctrl+Alt+B = Implementation),
    // so this legacy CodeMirror binding must not act as a second dispatcher.
    if (hasActionHost()) return false;
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void definitionRef.current(position);
    return true;
  };
  const referencesAtSelection = (view: EditorView) => {
    if (hasActionHost()) return false;
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void referencesRef.current(position);
    return true;
  };
  return [
    tooltips({
      position: "fixed",
      parent: typeof document !== "undefined" ? document.body : undefined,
      tooltipSpace: (view) => {
        const viewportWidth = typeof window === "undefined" ? 1000 : window.innerWidth;
        const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
        const rect = view.dom.getBoundingClientRect();
        // CodeMirror aligns a tooltip that is wider than its space with
        // space.left and lets it overrun space.right (TooltipPluginView
        // writeMeasure). The completion list is capped against the viewport,
        // not the editor pane, so keeping the horizontal space at the pane's
        // rect pushed the popup past the window edge on narrow layouts. The
        // horizontal space therefore spans the viewport; the vertical space
        // keeps the editor bounds that flip hover tooltips above the dock.
        return {
          top: Math.max(0, rect.top),
          left: 0,
          bottom: rect.bottom > 0 ? Math.min(rect.bottom, viewportHeight) : viewportHeight,
          right: rect.right > 0 ? Math.min(rect.right, viewportWidth) : viewportWidth,
        };
      },
    }),
    createLspHyperlinkExtension({
      onDefinition: (position) => definitionRef.current(position),
    }),
    keymap.of([
      { key: "F12", run: definitionAtSelection },
      { key: "Shift-F12", run: referencesAtSelection },
      { key: "Mod-b", run: definitionAtSelection },
      { key: "Mod-Alt-B", run: definitionAtSelection },
    ]),
  ];
}


export function lspHoverExtension(
  hoverRef: MutableRefObject<(position: LspPosition) => Promise<QuickDocContent | null>>,
  onPinHoverDocRef: MutableRefObject<((content: QuickDocContent) => void) | undefined>,
  activeResizeSessionRef: MutableRefObject<WindowResizeSession | null>,
  enabled: boolean,
  hoverTime: number,
): Extension {
  if (!enabled) return [];
  // IDEA keeps the hover popup while the pointer moves towards it or rests in
  // it (hoverDocTooltip); CodeMirror's hoverTooltip closed it on the first
  // pointer move off the hovered character.
  return hoverDocTooltip({
    hoverTime,
    isBusy: () => !!activeResizeSessionRef.current,
    source: (view, pos) => {
      const position = lspPositionFromOffset(view.state.doc, pos);
      return hoverRef.current(position).then((content) => {
        if (!content) return null;
        const title = extractIdentifierAtPos(view.state.doc, pos);
        const displayContent = content.title ? content : { ...content, title };
        return {
          create: (close) => {
            // Same structure as before: the .cm-tooltip-hover wrapper stays
            // transparent and the container draws the popup chrome.
            const wrapper = document.createElement("div");
            wrapper.className = "cm-tooltip-hover";
            wrapper.appendChild(createHoverDocDom({
              content: displayContent,
              onPin: onPinHoverDocRef.current,
              onClose: close,
              activeResizeSessionRef,
            }));
            return {
              dom: wrapper,
              destroy: () => cancelActiveHoverResize(activeResizeSessionRef),
            };
          },
        };
      });
    },
  });
}


export function foldHoverProvenanceTooltip(resolvePath: () => string | null | undefined): Extension {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const provenance = detectLineFoldProvenance(view.state, line.number, resolvePath());
    if (!provenance) return null;
    return {
      pos: line.from,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-fold-hover-tooltip px-2 py-1 text-[11px] rounded bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)] border border-[var(--taomni-code-border)] shadow-md";
        dom.setAttribute("data-testid", "code-workspace-fold-hover-tooltip");
        dom.setAttribute("data-fold-provenance", provenance);
        dom.textContent = `Region fold source: ${provenance}`;
        return { dom };
      },
    };
  }, { hoverTime: 250 });
}

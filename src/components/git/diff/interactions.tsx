import { EditorView } from "@codemirror/view";
import { MergeView, type Chunk } from "@codemirror/merge";
import { clampNumber, applySplitDiffLayout, CONNECTOR_WIDTH, MIN_PANE_WIDTH, splitLayoutMetrics, MIN_SPLIT_CONTENT_WIDTH, elementWidth } from "./layout";


export function chunkKind(chunk: Chunk): "added" | "deleted" | "modified" {
  if (chunk.fromA === chunk.toA) return "added";
  if (chunk.fromB === chunk.toB) return "deleted";
  return "modified";
}


export function sideRange(view: EditorView, chunk: Chunk, side: "a" | "b"): { top: number; bottom: number } {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  const end = side === "a" ? chunk.endA : chunk.endB;
  const empty = from === to;
  const startPos = clampNumber(from, 0, docLength);
  const startBlock = view.lineBlockAt(startPos);
  const top = startBlock.top - view.scrollDOM.scrollTop;
  if (empty) {
    const markerHeight = clampNumber(startBlock.height * 0.25, 4, 8);
    return { top, bottom: top + markerHeight };
  }
  const endPos = clampNumber(Math.max(startPos, end - 1), 0, docLength);
  const endBlock = view.lineBlockAt(endPos);
  return { top, bottom: endBlock.bottom - view.scrollDOM.scrollTop };
}


export function connectorPath(left: { top: number; bottom: number }, right: { top: number; bottom: number }, width: number): string {
  const leftTop = Math.round(left.top * 10) / 10;
  const rightTop = Math.round(right.top * 10) / 10;
  const leftBottom = Math.max(leftTop + 3, Math.round(left.bottom * 10) / 10);
  const rightBottom = Math.max(rightTop + 3, Math.round(right.bottom * 10) / 10);
  const c1 = Math.round(width * 0.42);
  const c2 = Math.round(width * 0.58);
  return [
    `M 0 ${leftTop}`,
    `C ${c1} ${leftTop}, ${c2} ${rightTop}, ${width} ${rightTop}`,
    `L ${width} ${rightBottom}`,
    `C ${c2} ${rightBottom}, ${c1} ${leftBottom}, 0 ${leftBottom}`,
    "Z",
  ].join(" ");
}


export function mappedScrollTop(source: HTMLElement, target: HTMLElement): number {
  const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
  if (sourceMax === 0 || targetMax === 0) return 0;
  return (source.scrollTop / sourceMax) * targetMax;
}


export interface SplitInteractionOptions {
  isSyncEnabled: () => boolean;
  readPreferredRatio: () => number;
  commitPreferredRatio: (ratio: number) => void;
  leftPaneId: string;
  rightPaneId: string;
  cancelPendingScrollCorrection: () => void;
  onLayoutReady: () => void;
}


export interface DragState {
  pointerId: number;
  startClientX: number;
  startLeftWidth: number;
  startAvailableWidth: number;
  startPreferredRatio: number;
}


export function setupSplitDiffInteractions(mv: MergeView, options: SplitInteractionOptions): () => void {
  const initialLayout = applySplitDiffLayout(mv, options.readPreferredRatio());
  if (!initialLayout) return () => {};
  let layout = initialLayout;
  const { editorDom, leftWrap, rightWrap } = layout;

  leftWrap.id = options.leftPaneId;
  rightWrap.id = options.rightPaneId;

  editorDom.querySelector(".taomni-diff-connector")?.remove();

  const connector = document.createElement("div");
  connector.className = "taomni-diff-connector";
  connector.dataset.testid = "git-diff-splitter";
  connector.setAttribute("role", "separator");
  connector.setAttribute("aria-orientation", "vertical");
  connector.setAttribute("aria-label", "Resize diff panes");
  connector.tabIndex = 0;
  connector.setAttribute("aria-controls", `${options.leftPaneId} ${options.rightPaneId}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const pathLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(pathLayer);
  connector.appendChild(svg);
  editorDom.insertBefore(connector, rightWrap);
  connector.dataset.layoutReady = "false";

  const aScroll = mv.a.scrollDOM;
  const bScroll = mv.b.scrollDOM;
  aScroll.dataset.testid = "git-diff-left-scroll";
  bScroll.dataset.testid = "git-diff-right-scroll";
  let ignoreNextScroll: HTMLElement | null = null;
  let renderFrame = 0;
  let deferredRender = 0;
  let lastWidth = layout.width;
  let drag: DragState | null = null;
  let pendingClientX: number | null = null;
  let dragFrame = 0;
  let previewRatio: number | null = null;
  let previousBodyCursor = "";
  let previousBodyUserSelect = "";

  const renderConnectors = () => {
    renderFrame = 0;
    if (!connector.isConnected) return;
    const connectorRect = connector.getBoundingClientRect();
    const editorRect = editorDom.getBoundingClientRect();
    const layoutReady = connectorRect.width > 0
      && connectorRect.height > 0
      && editorRect.width > CONNECTOR_WIDTH
      && editorRect.height > 0;
    if (layoutReady && connector.dataset.layoutReady !== "true") {
      connector.dataset.layoutReady = "true";
      options.onLayoutReady();
    }
    const width = connector.clientWidth || CONNECTOR_WIDTH;
    const height =
      connector.clientHeight ||
      editorDom.clientHeight ||
      Math.max(aScroll.clientHeight, bScroll.clientHeight);
    if (height <= 0) return;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    const fragment = document.createDocumentFragment();
    for (const chunk of mv.chunks) {
      const left = sideRange(mv.a, chunk, "a");
      const right = sideRange(mv.b, chunk, "b");
      if (Math.max(left.bottom, right.bottom) < -24 || Math.min(left.top, right.top) > height + 24) {
        continue;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `taomni-diff-connector-path is-${chunkKind(chunk)}`);
      path.setAttribute("d", connectorPath(left, right, width));
      fragment.appendChild(path);
    }
    pathLayer.replaceChildren(fragment);
  };

  const queueRender = () => {
    if (renderFrame === 0) {
      renderFrame = window.requestAnimationFrame(renderConnectors);
    }
  };

  const updateSeparatorA11y = () => {
    const min = layout.disabled ? 50 : Math.round((MIN_PANE_WIDTH / layout.availableWidth) * 100);
    const max = layout.disabled ? 50 : 100 - min;
    connector.setAttribute("aria-disabled", String(layout.disabled));
    connector.setAttribute("aria-valuemin", String(min));
    connector.setAttribute("aria-valuemax", String(max));
    connector.setAttribute("aria-valuenow", String(Math.round(layout.effectiveRatio * 100)));
    connector.dataset.availableWidth = String(Math.round(layout.availableWidth));
  };

  const applyLayout = (preferredRatio: number) => {
    const next = applySplitDiffLayout(mv, preferredRatio);
    if (next) {
      layout = next;
      updateSeparatorA11y();
    }
    return next;
  };

  updateSeparatorA11y();

  const restoreDocumentStyles = () => {
    if (typeof document === "undefined" || !document.body) return;
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
  };

  const removeDragWindowListeners = () => {
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerCancel);
    window.removeEventListener("blur", onWindowBlur);
  };

  const endDrag = (commit: boolean) => {
    const state = drag;
    if (!state) return;
    drag = null;
    pendingClientX = null;
    if (dragFrame !== 0) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }

    const ratio = commit ? previewRatio : null;
    const restored = applyLayout(ratio ?? state.startPreferredRatio);
    if (commit && restored && !restored.disabled) {
      options.commitPreferredRatio(restored.effectiveRatio);
    }
    previewRatio = null;
    removeDragWindowListeners();
    connector.classList.remove("is-dragging");
    restoreDocumentStyles();
    if (connector.hasPointerCapture?.(state.pointerId)) {
      try {
        connector.releasePointerCapture(state.pointerId);
      } catch {
        /* Pointer capture may already have been lost. */
      }
    }
  };

  const pointerRatio = (clientX: number, state: DragState): number | null => {
    const current = splitLayoutMetrics(editorDom, options.readPreferredRatio());
    if (
      current.availableWidth < MIN_SPLIT_CONTENT_WIDTH
      || Math.abs(current.availableWidth - state.startAvailableWidth) > 0.5
    ) {
      return null;
    }
    const leftWidth = state.startLeftWidth + clientX - state.startClientX;
    const minRatio = MIN_PANE_WIDTH / current.availableWidth;
    return clampNumber(leftWidth / current.availableWidth, minRatio, 1 - minRatio);
  };

  const applyDragAt = (clientX: number): boolean => {
    const state = drag;
    if (!state) return false;
    const ratio = pointerRatio(clientX, state);
    if (ratio == null) return false;
    const next = applyLayout(ratio);
    if (!next || next.disabled) return false;
    previewRatio = next.effectiveRatio;
    return true;
  };

  const applyPendingDrag = () => {
    dragFrame = 0;
    if (!drag || pendingClientX == null) return;
    const clientX = pendingClientX;
    pendingClientX = null;
    if (!applyDragAt(clientX)) endDrag(false);
  };

  const queueDragAt = (clientX: number) => {
    pendingClientX = clientX;
    if (dragFrame === 0) dragFrame = window.requestAnimationFrame(applyPendingDrag);
  };

  function onWindowPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
      endDrag(false);
      return;
    }
    event.preventDefault();
    queueDragAt(event.clientX);
  }

  function onWindowPointerUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    if (dragFrame !== 0) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    const applied = applyDragAt(event.clientX);
    endDrag(applied);
  }

  function onWindowPointerCancel(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    endDrag(false);
  }

  function onWindowBlur() {
    if (drag) endDrag(false);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || ("isPrimary" in event && !event.isPrimary)) return;
    options.cancelPendingScrollCorrection();
    const current = applyLayout(options.readPreferredRatio());
    if (!current || current.disabled || current.availableWidth <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    connector.focus();
    drag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startLeftWidth: current.leftWidth,
      startAvailableWidth: current.availableWidth,
      startPreferredRatio: options.readPreferredRatio(),
    };
    previewRatio = current.effectiveRatio;
    previousBodyCursor = document.body?.style.cursor ?? "";
    previousBodyUserSelect = document.body?.style.userSelect ?? "";
    if (document.body) {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    connector.classList.add("is-dragging");
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    if (connector.setPointerCapture) {
      try {
        connector.setPointerCapture(event.pointerId);
      } catch {
        /* The window listeners remain the fallback when capture is unavailable. */
      }
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
      endDrag(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    queueDragAt(event.clientX);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onWindowPointerUp(event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onWindowPointerCancel(event);
  };

  const onLostPointerCapture = () => {
    if (drag) endDrag(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (drag) {
        event.preventDefault();
        endDrag(false);
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    const current = applyLayout(options.readPreferredRatio());
    if (!current) return;
    let nextRatio: number;
    if (event.key === "Enter") {
      nextRatio = 0.5;
    } else if (current.disabled) {
      return;
    } else if (event.key === "Home") {
      nextRatio = MIN_PANE_WIDTH / current.availableWidth;
    } else if (event.key === "End") {
      nextRatio = 1 - MIN_PANE_WIDTH / current.availableWidth;
    } else {
      const delta = event.shiftKey ? 0.1 : 0.02;
      nextRatio = current.effectiveRatio + (event.key === "ArrowRight" ? delta : -delta);
    }
    event.preventDefault();
    const next = applyLayout(nextRatio);
    if (next && !next.disabled) options.commitPreferredRatio(next.effectiveRatio);
  };

  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    options.cancelPendingScrollCorrection();
    if (drag) endDrag(false);
    const next = applyLayout(0.5);
    if (next && !next.disabled) options.commitPreferredRatio(next.effectiveRatio);
  };

  const cancelPendingCorrection = () => options.cancelPendingScrollCorrection();
  const interactionTargets = [aScroll, bScroll, mv.a.dom, mv.b.dom];
  for (const target of interactionTargets) {
    target.addEventListener("wheel", cancelPendingCorrection, { passive: true });
    target.addEventListener("pointerdown", cancelPendingCorrection, { passive: true });
    target.addEventListener("touchstart", cancelPendingCorrection, { passive: true });
    target.addEventListener("beforeinput", cancelPendingCorrection);
    target.addEventListener("input", cancelPendingCorrection);
  }

  const handleScroll = (source: HTMLElement, target: HTMLElement) => {
    if (ignoreNextScroll === source) {
      ignoreNextScroll = null;
      queueRender();
      return;
    }
    if (options.isSyncEnabled()) {
      ignoreNextScroll = target;
      target.scrollTop = mappedScrollTop(source, target);
    }
    queueRender();
  };

  const onAScroll = () => handleScroll(aScroll, bScroll);
  const onBScroll = () => handleScroll(bScroll, aScroll);
  aScroll.addEventListener("scroll", onAScroll, { passive: true });
  bScroll.addEventListener("scroll", onBScroll, { passive: true });

  const handleResize = () => {
    const width = elementWidth(editorDom);
    if (width !== lastWidth) {
      const becameUsable = lastWidth <= CONNECTOR_WIDTH && width > CONNECTOR_WIDTH;
      if (drag) endDrag(false);
      lastWidth = width;
      applyLayout(options.readPreferredRatio());
      if (becameUsable) options.onLayoutReady();
    }
    // renderConnectors also runs on the next frame, but update the observable
    // readiness immediately for WebKit implementations that report ResizeObserver
    // before the connector's final flex rect is committed.
    const connectorRect = connector.getBoundingClientRect();
    const editorRect = editorDom.getBoundingClientRect();
    if (connectorRect.width > 0 && connectorRect.height > 0
      && editorRect.width > CONNECTOR_WIDTH && editorRect.height > 0
      && connector.dataset.layoutReady !== "true") {
      connector.dataset.layoutReady = "true";
      options.onLayoutReady();
    }
    queueRender();
  };
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handleResize) : null;
  resizeObserver?.observe(mv.dom);
  resizeObserver?.observe(editorDom);
  resizeObserver?.observe(connector);
  resizeObserver?.observe(aScroll);
  resizeObserver?.observe(bScroll);
  window.addEventListener("resize", handleResize);

  const onClick = () => {
    connector.focus();
  };
  connector.addEventListener("click", onClick);
  connector.addEventListener("pointerdown", onPointerDown);
  connector.addEventListener("pointermove", onPointerMove);
  connector.addEventListener("pointerup", onPointerUp);
  connector.addEventListener("pointercancel", onPointerCancel);
  connector.addEventListener("lostpointercapture", onLostPointerCapture);
  connector.addEventListener("keydown", onKeyDown);
  connector.addEventListener("dblclick", onDoubleClick);

  queueRender();
  deferredRender = window.setTimeout(queueRender, 80);
  if (layout.width > CONNECTOR_WIDTH) queueRender();

  return () => {
    options.cancelPendingScrollCorrection();
    endDrag(false);
    connector.removeEventListener("click", onClick);
    connector.removeEventListener("pointerdown", onPointerDown);
    connector.removeEventListener("pointermove", onPointerMove);
    connector.removeEventListener("pointerup", onPointerUp);
    connector.removeEventListener("pointercancel", onPointerCancel);
    connector.removeEventListener("lostpointercapture", onLostPointerCapture);
    connector.removeEventListener("keydown", onKeyDown);
    connector.removeEventListener("dblclick", onDoubleClick);
    for (const target of interactionTargets) {
      target.removeEventListener("wheel", cancelPendingCorrection);
      target.removeEventListener("pointerdown", cancelPendingCorrection);
      target.removeEventListener("touchstart", cancelPendingCorrection);
      target.removeEventListener("beforeinput", cancelPendingCorrection);
      target.removeEventListener("input", cancelPendingCorrection);
    }
    aScroll.removeEventListener("scroll", onAScroll);
    bScroll.removeEventListener("scroll", onBScroll);
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("blur", onWindowBlur);
    resizeObserver?.disconnect();
    if (dragFrame !== 0) window.cancelAnimationFrame(dragFrame);
    if (renderFrame !== 0) window.cancelAnimationFrame(renderFrame);
    if (deferredRender !== 0) window.clearTimeout(deferredRender);
    connector.remove();
  };
}


export function scrollChunkIntoView(view: EditorView, chunk: Chunk, side: "a" | "b") {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const anchor = clampNumber(from, 0, docLength);
  const lineStart = docLength === 0 ? 0 : view.state.doc.lineAt(anchor).from;
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const contentOrigin = contentRect.width > 0 && scrollerRect.width > 0
    ? contentRect.left - scrollerRect.left + view.scrollDOM.scrollLeft
    : 0;
  view.dispatch({
    selection: { anchor: lineStart },
    effects: EditorView.scrollIntoView(lineStart, {
      y: "center",
      x: "start",
      // Align the text origin rather than the gutter edge. Without this,
      // CodeMirror treats the line-number gutter as a horizontal offset.
      xMargin: Math.max(0, contentOrigin),
    }),
  });
  // CodeMirror applies the scroll effect during its next measure. Set the
  // horizontal origin immediately as well so navigation never exposes a
  // transient horizontal offset to the next interaction or assertion.
  view.scrollDOM.scrollLeft = 0;
}

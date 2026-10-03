/** Horizontal scroll chrome helpers for the code-workspace editor tab strip. */

export type EditorTabScrollState = {
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
};

export const EDITOR_TAB_SCROLL_EDGE_TOLERANCE = 1;
export const EDITOR_TAB_SCROLL_PADDING = 8;
export const EDITOR_TAB_SCROLL_STEP_MIN = 160;

export function maxScrollLeft(el: { scrollWidth: number; clientWidth: number }): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

export function computeEditorTabScrollState(
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  edgeTolerance = EDITOR_TAB_SCROLL_EDGE_TOLERANCE,
): EditorTabScrollState {
  const maxLeft = maxScrollLeft(el);
  return {
    overflow: maxLeft > edgeTolerance,
    atStart: el.scrollLeft <= edgeTolerance,
    atEnd: el.scrollLeft >= maxLeft - edgeTolerance,
  };
}

export function editorTabScrollStep(clientWidth: number, stepMin = EDITOR_TAB_SCROLL_STEP_MIN): number {
  return Math.max(stepMin, Math.floor(clientWidth * 0.8));
}

/**
 * Map a child's viewport box into the container's scroll-content coordinate
 * system. Uses getBoundingClientRect (not offsetLeft) so a left sidebar that
 * makes offsetParent === body does not poison scroll math — same approach as
 * the main TabBar ensure-visible path.
 */
export function contentRangeFromRects(
  container: { getBoundingClientRect: () => Pick<DOMRect, "left">; scrollLeft: number },
  child: { getBoundingClientRect: () => Pick<DOMRect, "left" | "right"> },
): { left: number; right: number } {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  return {
    left: childRect.left - containerRect.left + container.scrollLeft,
    right: childRect.right - containerRect.left + container.scrollLeft,
  };
}

/**
 * Returns the scrollLeft needed to bring `contentLeft..contentRight` fully into
 * the container's visible range (with padding). Unchanged when already visible.
 */
export function ensureContentRangeVisibleScrollLeft(
  scrollLeft: number,
  clientWidth: number,
  contentLeft: number,
  contentRight: number,
  padding = EDITOR_TAB_SCROLL_PADDING,
): number {
  const visibleLeft = scrollLeft;
  const visibleRight = visibleLeft + clientWidth;
  if (contentLeft < visibleLeft + padding) {
    return Math.max(0, contentLeft - padding);
  }
  if (contentRight > visibleRight - padding) {
    return Math.max(0, contentRight - clientWidth + padding);
  }
  return scrollLeft;
}

/**
 * Returns the scrollLeft needed to bring `child` fully into the container's
 * visible range. Geometry is derived from getBoundingClientRect so it stays
 * correct when the strip is offset by a left project pane (offsetLeft alone is
 * unreliable in Chromium when offsetParent is body).
 */
export function ensureChildVisibleScrollLeft(
  container: {
    scrollLeft: number;
    clientWidth: number;
    getBoundingClientRect: () => Pick<DOMRect, "left">;
  },
  child: {
    getBoundingClientRect: () => Pick<DOMRect, "left" | "right">;
  },
  padding = EDITOR_TAB_SCROLL_PADDING,
): number {
  const { left, right } = contentRangeFromRects(container, child);
  return ensureContentRangeVisibleScrollLeft(
    container.scrollLeft,
    container.clientWidth,
    left,
    right,
    padding,
  );
}

export function setScrollLeft(el: HTMLElement, left: number): void {
  const next = Math.max(0, Math.min(left, maxScrollLeft(el)));
  el.scrollLeft = next;
  if (typeof el.scrollTo === "function") {
    try {
      el.scrollTo({ left: next });
    } catch {
      // scrollLeft assignment above is enough for older WebViews / jsdom.
    }
  }
}

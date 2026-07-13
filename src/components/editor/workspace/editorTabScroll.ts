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
 * Returns the scrollLeft needed to bring `child` fully into the container's
 * visible range (with padding). Returns the current scrollLeft when already visible.
 */
export function ensureChildVisibleScrollLeft(
  container: { scrollLeft: number; clientWidth: number },
  child: { offsetLeft: number; offsetWidth: number },
  padding = EDITOR_TAB_SCROLL_PADDING,
): number {
  const visibleLeft = container.scrollLeft;
  const visibleRight = visibleLeft + container.clientWidth;
  const childLeft = child.offsetLeft;
  const childRight = childLeft + child.offsetWidth;
  if (childLeft < visibleLeft + padding) {
    return Math.max(0, childLeft - padding);
  }
  if (childRight > visibleRight - padding) {
    return Math.max(0, childRight - container.clientWidth + padding);
  }
  return container.scrollLeft;
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

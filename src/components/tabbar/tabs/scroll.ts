export const TAB_DRAG_MIME = "taomni/tab";

export const TAB_SCROLL_EDGE_TOLERANCE = 1;

export const TAB_SCROLL_PADDING = 8;

export const TAB_SCROLL_STEP_MIN = 160;

export function maxScrollLeft(el: HTMLElement): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

export function setTabScrollLeft(el: HTMLElement, left: number) {
  const next = Math.max(0, Math.min(left, maxScrollLeft(el)));
  el.scrollLeft = next;
  if (typeof el.scrollTo === "function") {
    try {
      el.scrollTo({ left: next });
    } catch {
      // The assigned scrollLeft above is enough for older WebViews and tests.
    }
  }
}

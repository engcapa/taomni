import type { Virtualizer } from "@tanstack/react-virtual";

type ObserveOffsetCallback = (offset: number, isScrolling: boolean) => void;

/**
 * Observes scroll offsets without leaking pending reset timers on cleanup.
 * Upstream `@tanstack/virtual-core` omits `clearTimeout` in `observeElementOffset`,
 * leaving `isScrollingResetDelay` timers active after unmount or test teardown.
 */
export function observeElementOffsetClean<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  cb: ObserveOffsetCallback,
): (() => void) | undefined {
  const element = instance.scrollElement;
  const targetWindow = instance.targetWindow;
  if (!element || !targetWindow) return;

  let disposed = false;
  let offset = 0;
  let timeoutId: number | undefined;
  const registerScrollendEvent =
    instance.options.useScrollendEvent && "onscrollend" in targetWindow;

  const scheduleReset = () => {
    if (registerScrollendEvent || disposed) return;
    targetWindow.clearTimeout(timeoutId);
    timeoutId = targetWindow.setTimeout(() => {
      timeoutId = undefined;
      if (!disposed && typeof window !== "undefined") cb(offset, false);
    }, instance.options.isScrollingResetDelay);
  };

  const createHandler = (isScrolling: boolean) => () => {
    if (disposed) return;
    const { horizontal, isRtl } = instance.options;
    offset = horizontal
      ? element.scrollLeft * (isRtl ? -1 : 1)
      : element.scrollTop;
    scheduleReset();
    cb(offset, isScrolling);
  };

  const handler = createHandler(true);
  const endHandler = createHandler(false);
  endHandler();

  const listenerOptions: AddEventListenerOptions = { passive: true };
  element.addEventListener("scroll", handler, listenerOptions);
  if (registerScrollendEvent) {
    element.addEventListener("scrollend", endHandler, listenerOptions);
  }

  return () => {
    disposed = true;
    targetWindow.clearTimeout(timeoutId);
    timeoutId = undefined;
    element.removeEventListener("scroll", handler);
    if (registerScrollendEvent) {
      element.removeEventListener("scrollend", endHandler);
    }
  };
}

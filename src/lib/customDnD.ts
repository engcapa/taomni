// Pointer-driven drag-and-drop, kept independent of the HTML5 DnD API.
//
// Why: with `dragDropEnabled: true` (Tauri 2's default + required for OS file
// drop into the webview on Windows), the native drag-drop handler intercepts
// HTML5 dragstart/drop events on Windows. That breaks intra-app drags built on
// `draggable`/`onDragStart`/`onDrop`. We re-implement just enough of HTML5
// drag semantics on top of pointer events so SFTP cross-pane, tab reorder, and
// session→folder drags keep working without touching the Tauri flag.
//
// Drop targets register via `useCustomDropTarget`, which subscribes to the
// global pointer stream and self-filters by hit-testing its own element.

import { useEffect, useRef, type RefObject } from "react";

export interface CustomDragData {
  /** Application-defined key (e.g. "taomni/tab", "taomni/session"). */
  mime: string;
  /** Arbitrary serialisable payload — drop targets read this. */
  payload: unknown;
}

export interface CustomDragEventDetail {
  data: CustomDragData;
  clientX: number;
  clientY: number;
  /** Topmost element under the cursor at the time of dispatch. */
  target: Element | null;
}

const POINTER_EVENT = "taomni:custom-drag-pointer";
const END_EVENT = "taomni:custom-drag-end";

interface PointerEventDetail extends CustomDragEventDetail {
  phase: "move" | "drop" | "cancel";
}

interface ActiveDrag {
  data: CustomDragData;
  startX: number;
  startY: number;
  threshold: number;
  activated: boolean;
  ghost: HTMLElement | null;
  ghostOffsetX: number;
  ghostOffsetY: number;
  pointerId: number;
  onEnd?: () => void;
  onCancel?: () => void;
  cleanup: () => void;
}

let active: ActiveDrag | null = null;

export function isCustomDragActive(): boolean {
  return !!active?.activated;
}

export function getActiveCustomDragData(): CustomDragData | null {
  return active ? active.data : null;
}

interface StartOpts {
  /** The pointerdown / mousedown event that initiated the drag. */
  event: { clientX: number; clientY: number; pointerId?: number; button?: number };
  data: CustomDragData;
  /** Pixels of pointer travel before activation. Default 4. */
  thresholdPx?: number;
  /** Optional ghost text shown next to the cursor while dragging. */
  ghostText?: string;
  /** Optional element cloned as ghost (overrides ghostText if both given). */
  ghostElement?: HTMLElement | null;
  /** Fired the first time the threshold is crossed (real drag begins). */
  onActivate?: () => void;
  /** Fired after pointerup or cancel. */
  onEnd?: () => void;
  /** Fired only on cancellation (Escape, blur, pointercancel). */
  onCancel?: () => void;
}

export function startCustomDrag(opts: StartOpts): void {
  if (opts.event.button != null && opts.event.button !== 0) return;
  if (active) cancelActive();

  const drag: ActiveDrag = {
    data: opts.data,
    startX: opts.event.clientX,
    startY: opts.event.clientY,
    threshold: opts.thresholdPx ?? 4,
    activated: false,
    ghost: null,
    ghostOffsetX: 12,
    ghostOffsetY: 12,
    pointerId: opts.event.pointerId ?? -1,
    onEnd: opts.onEnd,
    onCancel: opts.onCancel,
    cleanup: () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur, true);
    },
  };
  active = drag;

  const ensureActivated = (clientX: number, clientY: number): boolean => {
    if (drag.activated) return true;
    const dx = clientX - drag.startX;
    const dy = clientY - drag.startY;
    if (dx * dx + dy * dy < drag.threshold * drag.threshold) return false;
    drag.activated = true;
    drag.ghost = createGhost(opts.ghostElement ?? null, opts.ghostText ?? null);
    if (drag.ghost) {
      document.body.appendChild(drag.ghost);
      positionGhost(drag, clientX, clientY);
    }
    suppressNextClick();
    opts.onActivate?.();
    return true;
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (!ensureActivated(ev.clientX, ev.clientY)) return;
    ev.preventDefault();
    positionGhost(drag, ev.clientX, ev.clientY);
    emit({
      phase: "move",
      data: drag.data,
      clientX: ev.clientX,
      clientY: ev.clientY,
      target: pointerTarget(ev.clientX, ev.clientY, drag.ghost),
    });
  };

  const finish = (clientX: number, clientY: number, dropped: boolean) => {
    if (!active || active !== drag) return;
    if (drag.activated) {
      const target = pointerTarget(clientX, clientY, drag.ghost);
      emit({
        phase: dropped ? "drop" : "cancel",
        data: drag.data,
        clientX,
        clientY,
        target,
      });
      window.dispatchEvent(
        new CustomEvent<CustomDragEventDetail>(END_EVENT, {
          detail: { data: drag.data, clientX, clientY, target },
        }),
      );
    }
    drag.cleanup();
    if (drag.ghost && drag.ghost.parentNode) {
      drag.ghost.parentNode.removeChild(drag.ghost);
    }
    active = null;
    if (!dropped) drag.onCancel?.();
    drag.onEnd?.();
  };

  const onPointerUp = (ev: PointerEvent) => {
    finish(ev.clientX, ev.clientY, true);
  };

  const onPointerCancel = (ev: PointerEvent) => {
    finish(ev.clientX, ev.clientY, false);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && active === drag) {
      ev.preventDefault();
      finish(drag.startX, drag.startY, false);
    }
  };

  const onBlur = () => {
    if (active === drag) finish(drag.startX, drag.startY, false);
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onBlur, true);
}

function emit(detail: PointerEventDetail) {
  window.dispatchEvent(new CustomEvent<PointerEventDetail>(POINTER_EVENT, { detail }));
}

function cancelActive() {
  if (!active) return;
  active.cleanup();
  if (active.ghost && active.ghost.parentNode) {
    active.ghost.parentNode.removeChild(active.ghost);
  }
  active = null;
}

function pointerTarget(x: number, y: number, ghost: HTMLElement | null): Element | null {
  // Hide the ghost briefly so elementFromPoint sees the real target underneath.
  let prevDisplay: string | null = null;
  if (ghost) {
    prevDisplay = ghost.style.display;
    ghost.style.display = "none";
  }
  const target = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = prevDisplay ?? "";
  return target;
}

function createGhost(element: HTMLElement | null, text: string | null): HTMLElement | null {
  if (!element && !text) return null;
  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "0";
  wrapper.style.top = "0";
  wrapper.style.pointerEvents = "none";
  wrapper.style.zIndex = "2147483647";
  wrapper.style.opacity = "0.85";
  wrapper.style.transformOrigin = "0 0";
  wrapper.dataset.customDragGhost = "true";

  if (element) {
    const clone = element.cloneNode(true) as HTMLElement;
    const rect = element.getBoundingClientRect();
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    clone.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
    wrapper.appendChild(clone);
  } else if (text) {
    wrapper.textContent = text;
    wrapper.style.padding = "2px 8px";
    wrapper.style.background = "var(--taomni-accent, #2b5d8b)";
    wrapper.style.color = "#fff";
    wrapper.style.font = "12px system-ui, sans-serif";
    wrapper.style.borderRadius = "3px";
    wrapper.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    wrapper.style.whiteSpace = "nowrap";
    wrapper.style.maxWidth = "240px";
    wrapper.style.overflow = "hidden";
    wrapper.style.textOverflow = "ellipsis";
  }

  return wrapper;
}

function positionGhost(drag: ActiveDrag, x: number, y: number) {
  if (!drag.ghost) return;
  drag.ghost.style.transform = `translate(${x + drag.ghostOffsetX}px, ${y + drag.ghostOffsetY}px)`;
}

// HTML5 drag suppresses the click that would otherwise fire on pointerup.
// Mirror that so callers don't see a stray select / activate after a drop.
function suppressNextClick() {
  const onClick = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.removeEventListener("click", onClick, true);
  };
  window.addEventListener("click", onClick, true);
  window.setTimeout(() => window.removeEventListener("click", onClick, true), 0);
}

export interface CustomDropHandlers {
  /** Return true if the drop target accepts the dragged data. */
  accepts: (data: CustomDragData) => boolean;
  onDragEnter?: (detail: CustomDragEventDetail) => void;
  onDragOver?: (detail: CustomDragEventDetail) => void;
  onDragLeave?: () => void;
  onDrop: (detail: CustomDragEventDetail) => void;
}

export function useCustomDropTarget<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handlers: CustomDropHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let entered = false;

    const onPointer = (ev: Event) => {
      const detail = (ev as CustomEvent<PointerEventDetail>).detail;
      const el = ref.current;
      const target = detail.target;
      const inside = !!(el && target && (el === target || el.contains(target)));
      const accepted = inside && handlersRef.current.accepts(detail.data);

      if (detail.phase === "move") {
        if (accepted) {
          if (!entered) {
            entered = true;
            handlersRef.current.onDragEnter?.(detail);
          }
          handlersRef.current.onDragOver?.(detail);
        } else if (entered) {
          entered = false;
          handlersRef.current.onDragLeave?.();
        }
        return;
      }
      // drop or cancel
      if (detail.phase === "drop" && accepted) {
        entered = false;
        handlersRef.current.onDrop(detail);
      } else if (entered) {
        entered = false;
        handlersRef.current.onDragLeave?.();
      }
    };

    window.addEventListener(POINTER_EVENT, onPointer);
    return () => {
      window.removeEventListener(POINTER_EVENT, onPointer);
    };
  }, [ref]);
}

export const __customDragTesting = {
  POINTER_EVENT,
  END_EVENT,
};

/**
 * IDEA-style hover documentation popup for CodeMirror.
 *
 * CodeMirror's `hoverTooltip` closes as soon as the pointer leaves the hovered
 * character, so the popup vanished while the user moved toward it. IDEA's
 * EditorMouseHoverPopupManager instead keeps the popup while the pointer stays
 * on the hovered element, rests inside the popup, or is moving towards it
 * (MouseMovementTracker.isMovingTowards); it closes after a short grace period
 * once the pointer goes elsewhere, and a popup the user clicked into stays
 * until Esc or focus leaves it.
 */

import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip } from "@codemirror/view";

export interface HoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HoverPoint {
  x: number;
  y: number;
}

/** Slack around the popup, like CodeMirror's tooltipMargin. */
export const HOVER_DOC_MARGIN = 4;

export function pointInRect(point: HoverPoint, rect: HoverRect, margin = HOVER_DOC_MARGIN): boolean {
  return point.x >= rect.left - margin && point.x <= rect.right + margin
    && point.y >= rect.top - margin && point.y <= rect.bottom + margin;
}

/**
 * Whether the pointer, moving from `previous` to `current`, is heading into
 * `rect` (a ray/rectangle slab test, the geometric core of IDEA's
 * MouseMovementTracker.isMovingTowards). A pointer already inside counts.
 */
export function isMovingTowardsRect(previous: HoverPoint | null, current: HoverPoint, rect: HoverRect, margin = HOVER_DOC_MARGIN): boolean {
  if (pointInRect(current, rect, margin)) return true;
  if (!previous) return false;
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false;
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;
  const axes: Array<[number, number, number, number]> = [
    [current.x, dx, rect.left - margin, rect.right + margin],
    [current.y, dy, rect.top - margin, rect.bottom + margin],
  ];
  for (const [origin, delta, low, high] of axes) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < low || origin > high) return false;
      continue;
    }
    let t1 = (low - origin) / delta;
    let t2 = (high - origin) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

/** Hide grace once the pointer goes elsewhere, derived from the hover delay. */
export function hoverDocHideGraceMs(hoverTime: number): number {
  return Math.max(150, Math.min(hoverTime, 500));
}

export interface HoverDocSourceResult {
  /** Build the popup DOM; `close` dismisses it. */
  create: (close: () => void) => { dom: HTMLElement; destroy?: () => void };
}

export interface HoverDocOptions {
  /** Pointer rest time before a lookup (IDEA "Show quick documentation on hover" delay). */
  hoverTime: number;
  /** Look up documentation at a document offset. */
  source: (view: EditorView, pos: number) => Promise<HoverDocSourceResult | null>;
  /** While true (e.g. a resize drag), the popup never auto-hides. */
  isBusy?: () => boolean;
}

interface HoverDocState {
  from: number;
  to: number;
  tooltip: Tooltip;
}

const setHoverDoc = StateEffect.define<HoverDocState | null>();

export const hoverDocField = StateField.define<HoverDocState | null>({
  create: () => null,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) if (effect.is(setHoverDoc)) next = effect.value;
    // hideOnChange: typing or setting the selection closes the popup.
    if (next && next === value && (tr.docChanged || tr.selection)) return null;
    if (next && tr.docChanged) {
      next = { ...next, from: tr.changes.mapPos(next.from), to: tr.changes.mapPos(next.to) };
    }
    return next;
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

/** Show a popup for [from, to] directly (tests; the plugin normally does this). */
export function openHoverDoc(view: EditorView, from: number, to: number, create: Tooltip["create"]): void {
  view.dispatch({ effects: setHoverDoc.of({ from, to, tooltip: { pos: from, end: to, above: true, create } }) });
}

/** Close the hover documentation popup of `view`, if any. */
export function closeHoverDoc(view: EditorView): boolean {
  if (!view.state.field(hoverDocField, false)) return false;
  view.dispatch({ effects: setHoverDoc.of(null) });
  return true;
}

function hoverRangeAt(view: EditorView, pos: number): { from: number; to: number } {
  const word = view.state.wordAt(pos);
  return word ? { from: word.from, to: word.to } : { from: pos, to: pos };
}

let ownerSequence = 0;

export function hoverDocTooltip(options: HoverDocOptions): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private readonly ownerId = `hover-doc-${++ownerSequence}`;
    private hoverTimer = -1;
    private hideTimer = -1;
    private lastMove: HoverPoint & { time: number; target: EventTarget | null } = { x: 0, y: 0, time: 0, target: null };
    private previousMove: HoverPoint | null = null;
    /** The last move headed for the popup: stay, and do not start a new lookup. */
    private towardPopup = false;
    private pending: object | null = null;
    private watchedDom: HTMLElement | null = null;

    constructor(readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.onEditorMouseMove);
      view.dom.addEventListener("mouseleave", this.onEditorMouseLeave);
    }

    update() {
      if (this.active) return;
      this.cancelHide();
      this.unwatchDom();
      this.towardPopup = false;
    }

    get active(): HoverDocState | null {
      return this.view.state.field(hoverDocField, false) ?? null;
    }

    private tooltipDom(): HTMLElement | null {
      if (!this.active) return null;
      if (this.watchedDom?.isConnected) return this.watchedDom;
      return document.querySelector<HTMLElement>(`[data-hover-doc-owner="${this.ownerId}"]`);
    }

    private overRange(point: HoverPoint): boolean {
      const active = this.active;
      if (!active) return false;
      const start = this.view.coordsAtPos(active.from, 1);
      const end = this.view.coordsAtPos(active.to, -1);
      if (!start || !end) return false;
      return pointInRect(point, {
        left: Math.min(start.left, end.left),
        right: Math.max(start.right, end.right),
        top: Math.min(start.top, end.top),
        bottom: Math.max(start.bottom, end.bottom),
      }, 1);
    }

    private recordMove(event: MouseEvent) {
      this.previousMove = this.lastMove.time ? { x: this.lastMove.x, y: this.lastMove.y } : null;
      this.lastMove = { x: event.clientX, y: event.clientY, time: Date.now(), target: event.target };
    }

    /** Keep, or schedule hiding, the popup for the pointer's latest move. */
    private evaluatePointer(event: MouseEvent) {
      if (!this.active) return;
      const dom = this.tooltipDom();
      const target = event.target instanceof Node ? event.target : null;
      if (dom && target && dom.contains(target)) {
        this.towardPopup = false;
        this.cancelHide();
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      const rect = dom?.getBoundingClientRect() ?? null;
      this.towardPopup = !!rect && isMovingTowardsRect(this.previousMove, point, rect);
      if (this.towardPopup || this.overRange(point)) this.cancelHide();
      else this.scheduleHide();
    }

    private readonly onEditorMouseMove = (event: MouseEvent) => {
      this.recordMove(event);
      if (event.buttons !== 0) {
        // Selecting text: no lookups; an open popup follows hideOnChange.
        this.clearHoverTimer();
        return;
      }
      this.evaluatePointer(event);
      if (this.towardPopup) {
        this.clearHoverTimer();
        return;
      }
      if (this.hoverTimer < 0) this.hoverTimer = window.setTimeout(this.checkHover, options.hoverTime);
    };

    private readonly onEditorMouseLeave = (event: MouseEvent) => {
      this.clearHoverTimer();
      if (!this.active) return;
      this.recordMove(event);
      const dom = this.tooltipDom();
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (dom && related && dom.contains(related)) {
        this.cancelHide();
        return;
      }
      this.evaluatePointer(event);
    };

    /** Moves outside the editor (the popup lives under document.body). */
    private readonly onDocumentMouseMove = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && this.view.dom.contains(target)) return;
      this.recordMove(event);
      this.evaluatePointer(event);
    };

    private readonly onTooltipFocusOut = (event: FocusEvent) => {
      const dom = this.tooltipDom();
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (dom && next && dom.contains(next)) return;
      const target = this.lastMove.target instanceof Node ? this.lastMove.target : null;
      if (dom && target && dom.contains(target)) return;
      this.scheduleHide();
    };

    private readonly onTooltipKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeHoverDoc(this.view);
      this.view.focus();
    };

    watchDom(dom: HTMLElement) {
      if (dom === this.watchedDom) return;
      this.unwatchDom();
      this.watchedDom = dom;
      dom.addEventListener("focusout", this.onTooltipFocusOut);
      dom.addEventListener("keydown", this.onTooltipKeyDown);
      document.addEventListener("mousemove", this.onDocumentMouseMove);
    }

    private unwatchDom() {
      const dom = this.watchedDom;
      if (!dom) return;
      dom.removeEventListener("focusout", this.onTooltipFocusOut);
      dom.removeEventListener("keydown", this.onTooltipKeyDown);
      document.removeEventListener("mousemove", this.onDocumentMouseMove);
      this.watchedDom = null;
    }

    /** IDEA keeps a popup the user clicked into (focus inside) until Esc or focus leaves. */
    private popupHoldsFocus(): boolean {
      const dom = this.tooltipDom();
      return !!dom && dom.contains(document.activeElement);
    }

    private scheduleHide() {
      if (this.hideTimer >= 0) return;
      this.hideTimer = window.setTimeout(() => {
        this.hideTimer = -1;
        if (!this.active || options.isBusy?.() || this.popupHoldsFocus()) return;
        const dom = this.tooltipDom();
        const point = { x: this.lastMove.x, y: this.lastMove.y };
        const target = this.lastMove.target instanceof Node ? this.lastMove.target : null;
        if ((dom && target && dom.contains(target)) || this.overRange(point)) return;
        closeHoverDoc(this.view);
      }, hoverDocHideGraceMs(options.hoverTime));
    }

    private cancelHide() {
      if (this.hideTimer >= 0) window.clearTimeout(this.hideTimer);
      this.hideTimer = -1;
    }

    private clearHoverTimer() {
      if (this.hoverTimer >= 0) window.clearTimeout(this.hoverTimer);
      this.hoverTimer = -1;
    }

    private readonly checkHover = () => {
      this.hoverTimer = -1;
      const rested = Date.now() - this.lastMove.time;
      if (rested < options.hoverTime) {
        this.hoverTimer = window.setTimeout(this.checkHover, options.hoverTime - rested);
        return;
      }
      if (this.towardPopup) return;
      const point = { x: this.lastMove.x, y: this.lastMove.y };
      const target = this.lastMove.target instanceof Node ? this.lastMove.target : null;
      if (!target || !this.view.contentDOM.contains(target)) return;
      if (this.active && this.overRange(point)) return;
      const pos = this.view.posAtCoords(point);
      if (pos == null) return;
      const coords = this.view.coordsAtPos(pos);
      if (!coords
        || point.y < coords.top || point.y > coords.bottom
        || point.x < coords.left - this.view.defaultCharacterWidth
        || point.x > coords.right + this.view.defaultCharacterWidth) return;
      const range = hoverRangeAt(this.view, pos);
      const token = {};
      this.pending = token;
      void options.source(this.view, pos).then((result) => {
        if (this.pending !== token) return;
        this.pending = null;
        if (!result) return;
        // The pointer moved off the element while the lookup ran.
        const nowPos = this.view.posAtCoords({ x: this.lastMove.x, y: this.lastMove.y }, false);
        if (nowPos < range.from || nowPos > range.to) return;
        const view = this.view;
        this.cancelHide();
        openHoverDoc(view, range.from, range.to, () => {
          const created = result.create(() => closeHoverDoc(view));
          created.dom.setAttribute("data-hover-doc-owner", this.ownerId);
          this.watchDom(created.dom);
          return { dom: created.dom, destroy: created.destroy };
        });
      }, () => {
        if (this.pending === token) this.pending = null;
      });
    };

    destroy() {
      this.clearHoverTimer();
      this.cancelHide();
      this.unwatchDom();
      this.view.dom.removeEventListener("mousemove", this.onEditorMouseMove);
      this.view.dom.removeEventListener("mouseleave", this.onEditorMouseLeave);
    }
  });

  return [
    hoverDocField,
    plugin,
    Prec.high(keymap.of([{ key: "Escape", run: closeHoverDoc }])),
  ];
}

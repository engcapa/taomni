// Touch gestures for the phone terminal. xterm.js scrolls on wheel events but
// has no touch scrolling, so a drag on the terminal used to scroll the whole
// page. Normal scrollback uses the public scrollLines API. Other vertical
// drags become wheel events, preserving xterm's mouse wheel reports when
// the program enabled mouse tracking, and ↑/↓ in full-screen
// programs without scrollback (less, vim, Claude Code). A short flick keeps
// scrolling with decaying speed; a two-finger pinch steps the font size.

const DRAG_START_PX = 8;
const PINCH_STEP = 1.18;
const MIN_VELOCITY = 0.03; // px per ms
const FRICTION = 0.94; // per 16 ms frame

export interface TouchOptions {
  /** Element that receives the synthetic wheel events (xterm's `.xterm-screen`). */
  screen: () => HTMLElement | null;
  onPinch: (step: 1 | -1) => void;
  /** Normal scrollback uses xterm's public API; return true when handled. */
  onScroll?: (pixels: number) => boolean;
}

export function attachTouchGestures(target: HTMLElement, options: TouchOptions): () => void {
  let startY = 0;
  let lastY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let dragging = false;
  let pinchBase = 0;
  let frame = 0;

  const wheel = (deltaY: number) => {
    if (deltaY === 0 || options.onScroll?.(deltaY)) return;
    const screen = options.screen();
    if (!screen) return;
    const event = new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: lastX, clientY: lastY, bubbles: true, cancelable: true });
    // Chromium exposes wheelDeltaY=0 on synthetic events. xterm's viewport
    // prefers that legacy field over deltaY, so supply its actual wheel value.
    Object.defineProperty(event, "wheelDeltaY", { value: -deltaY * 3 });
    screen.dispatchEvent(event);
  };
  const stopMomentum = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

  const start = (event: TouchEvent) => {
    stopMomentum();
    if (event.touches.length === 2) { pinchBase = distance(event.touches); dragging = false; return; }
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startY = lastY = touch.clientY; lastX = touch.clientX;
    lastTime = event.timeStamp; velocity = 0; dragging = false; pinchBase = 0;
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length === 2 && pinchBase > 0) {
      event.preventDefault();
      const ratio = distance(event.touches) / pinchBase;
      if (ratio >= PINCH_STEP || ratio <= 1 / PINCH_STEP) {
        options.onPinch(ratio > 1 ? 1 : -1);
        pinchBase = distance(event.touches);
      }
      return;
    }
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!dragging && Math.abs(touch.clientY - startY) < DRAG_START_PX) return;
    dragging = true;
    event.preventDefault();
    // Finger up = content up = later lines, like native scrolling.
    const delta = lastY - touch.clientY;
    const elapsed = Math.max(1, event.timeStamp - lastTime);
    velocity = 0.8 * (delta / elapsed) + 0.2 * velocity;
    lastY = touch.clientY; lastX = touch.clientX; lastTime = event.timeStamp;
    wheel(delta);
  };
  const end = (event: TouchEvent) => {
    if (event.touches.length > 0) return;
    pinchBase = 0;
    if (!dragging) return;
    dragging = false;
    // A finger that stopped before lifting should not fling.
    if (event.timeStamp - lastTime > 80 || Math.abs(velocity) < MIN_VELOCITY * 4) return;
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(48, now - previous);
      previous = now;
      velocity *= Math.pow(FRICTION, elapsed / 16);
      if (Math.abs(velocity) < MIN_VELOCITY) { frame = 0; return; }
      wheel(velocity * elapsed);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  // Any fresh interaction (including the sibling “latest” button) interrupts
  // a fling, so momentum cannot pull the user back after scrollToBottom().
  const document = target.ownerDocument;
  document.addEventListener("pointerdown", stopMomentum, { passive: true });
  document.addEventListener("touchstart", stopMomentum, { passive: true });
  target.addEventListener("touchstart", start, { passive: true });
  target.addEventListener("touchmove", move, { passive: false });
  target.addEventListener("touchend", end, { passive: true });
  target.addEventListener("touchcancel", end, { passive: true });
  return () => {
    stopMomentum();
    document.removeEventListener("pointerdown", stopMomentum);
    document.removeEventListener("touchstart", stopMomentum);
    target.removeEventListener("touchstart", start);
    target.removeEventListener("touchmove", move);
    target.removeEventListener("touchend", end);
    target.removeEventListener("touchcancel", end);
  };
}

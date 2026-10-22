/**
 * Map mouse buttons to the 8-bit RFB button mask: bits 0-2 left/middle/right,
 * 3-6 wheel up/down/left/right, bit 7 the "back" (X1) button. The forward (X2)
 * button has no slot without the ExtendedMouseButtons extension.
 */
export function mouseButtonMask(e: MouseEvent | PointerEvent): number {
  let mask = 0;
  if (e.buttons & 1) mask |= 1; // left
  if (e.buttons & 2) mask |= 4; // right
  if (e.buttons & 4) mask |= 2; // middle
  if (e.buttons & 8) mask |= 0x80; // back
  return mask;
}

/** RFB wheel "buttons": one press+release pair per detent. */
export const VNC_WHEEL_UP = 0x08;

export const VNC_WHEEL_DOWN = 0x10;

export const VNC_WHEEL_LEFT = 0x20;

export const VNC_WHEEL_RIGHT = 0x40;

/** Pixel delta that counts as one wheel detent (Chromium/WebKit report 100 per notch). */
export const VNC_WHEEL_PIXELS_PER_STEP = 100;

export const VNC_WHEEL_LINES_PER_STEP = 3;

export const VNC_WHEEL_MAX_STEPS_PER_EVENT = 10;

/**
 * Accumulates DOM wheel deltas into discrete RFB wheel steps, the way RealVNC
 * Viewer applies its 120-unit ScrollWheelThreshold: a mouse notch is one step,
 * a trackpad's many small deltas add up instead of each firing a click.
 */
export class VncWheelAccumulator {
  private x = 0;
  private y = 0;

  /** Returns the wheel button masks to press+release, in order. */
  push(deltaX: number, deltaY: number, deltaMode: number): number[] {
    const unit = deltaMode === 1
      ? VNC_WHEEL_PIXELS_PER_STEP / VNC_WHEEL_LINES_PER_STEP
      : deltaMode === 2
        ? VNC_WHEEL_PIXELS_PER_STEP
        : 1;
    if (Number.isFinite(deltaX)) this.x += deltaX * unit;
    if (Number.isFinite(deltaY)) this.y += deltaY * unit;
    const steps: number[] = [];
    const drain = (value: number, negative: number, positive: number): number => {
      let remaining = value;
      while (Math.abs(remaining) >= VNC_WHEEL_PIXELS_PER_STEP && steps.length < VNC_WHEEL_MAX_STEPS_PER_EVENT) {
        steps.push(remaining < 0 ? negative : positive);
        remaining -= Math.sign(remaining) * VNC_WHEEL_PIXELS_PER_STEP;
      }
      // Drop backlog beyond the per-event cap instead of scrolling for seconds.
      return Math.abs(remaining) >= VNC_WHEEL_PIXELS_PER_STEP ? 0 : remaining;
    };
    this.y = drain(this.y, VNC_WHEEL_UP, VNC_WHEEL_DOWN);
    this.x = drain(this.x, VNC_WHEEL_LEFT, VNC_WHEEL_RIGHT);
    return steps;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}

export interface VncViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VncFramebufferPoint {
  x: number;
  y: number;
  /** False when the pointer is in fit-mode letterboxing or outside the canvas. */
  inside: boolean;
}

/**
 * Convert CSS-pixel pointer coordinates to remote framebuffer coordinates.
 * Device pixel ratio deliberately does not participate: RFB input follows the
 * remote logical framebuffer while the DOM event and canvas bounds are both in
 * CSS pixels.
 */
export function mapClientToFramebuffer(
  clientX: number,
  clientY: number,
  viewport: VncViewportRect,
  framebufferWidth: number,
  framebufferHeight: number,
  scaleMode: "fit" | "one",
): VncFramebufferPoint | null {
  if (![clientX, clientY, viewport.left, viewport.top, viewport.width, viewport.height]
    .every(Number.isFinite)
    || !Number.isInteger(framebufferWidth)
    || !Number.isInteger(framebufferHeight)
    || viewport.width <= 0
    || viewport.height <= 0
    || framebufferWidth <= 0
    || framebufferHeight <= 0) {
    return null;
  }

  let contentLeft = viewport.left;
  let contentTop = viewport.top;
  let contentWidth = viewport.width;
  let contentHeight = viewport.height;

  if (scaleMode === "fit") {
    const framebufferAspect = framebufferWidth / framebufferHeight;
    const viewportAspect = viewport.width / viewport.height;
    if (viewportAspect > framebufferAspect) {
      contentWidth = viewport.height * framebufferAspect;
      contentLeft += (viewport.width - contentWidth) / 2;
    } else {
      contentHeight = viewport.width / framebufferAspect;
      contentTop += (viewport.height - contentHeight) / 2;
    }
  }

  const inside = clientX >= contentLeft
    && clientX < contentLeft + contentWidth
    && clientY >= contentTop
    && clientY < contentTop + contentHeight;
  const x = Math.round((clientX - contentLeft) * framebufferWidth / contentWidth);
  const y = Math.round((clientY - contentTop) * framebufferHeight / contentHeight);
  return {
    x: Math.max(0, Math.min(framebufferWidth - 1, x)),
    y: Math.max(0, Math.min(framebufferHeight - 1, y)),
    inside,
  };
}

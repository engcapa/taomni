import { parseFrameHeader } from "./vnc";

/** Bounds on what the WebView buffers between two relay frame boundaries. */
export const VNC_MAX_PENDING_RECTS = 4096;
export const VNC_MAX_PENDING_FRAME_BYTES = 128 * 1024 * 1024;

interface PendingRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface VncPainterHost {
  getContext(): CanvasRenderingContext2D | null;
  /** Current negotiated framebuffer size (canvas backing store size). */
  framebufferSize(): { width: number; height: number };
  isVisible(): boolean;
  sendAck(): void;
  requestFullRefresh(): void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

/** Main-thread cost of relay frames, shown in Session Information (VNC-PERF-003). */
export interface VncPaintStats {
  framesPainted: number;
  /** Mean putImageData time per painted frame over the last stats window. */
  avgPaintMs: number;
  /** Receive (header parse + view) plus paint time of the latest near-full-screen frame. */
  fullFrame: { receiveMs: number; paintMs: number; pixels: number } | null;
}

/**
 * Collects relay rectangles between frame boundaries and paints them in one
 * animation frame, only when a boundary is pending. An idle session therefore
 * schedules no animation frames at all; the ACK that releases the next relay
 * frame is sent right after the paint, so the backend never waits on a
 * resident render loop.
 */
export class VncFramePainter {
  private pending: PendingRect[] = [];
  private pendingBytes = 0;
  private dropUntilBoundary = false;
  private boundaryPending = false;
  private frameHandle: number | null = null;
  private receiveMs = 0;
  private paintedInWindow = 0;
  private paintMsInWindow = 0;
  private framesPainted = 0;
  private fullFrame: VncPaintStats["fullFrame"] = null;
  private disposed = false;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;

  constructor(private readonly host: VncPainterHost) {
    this.requestFrame = host.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame = host.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
    this.now = host.now ?? (() => performance.now());
  }

  /** Handle one binary relay message (a rectangle, or the empty frame boundary). */
  receive(data: ArrayBuffer): void {
    if (this.disposed) return;
    if (data.byteLength === 0) {
      this.endFrame();
      return;
    }
    if (this.dropUntilBoundary) return;
    const started = this.now();
    const header = parseFrameHeader(data);
    const framebuffer = this.host.framebufferSize();
    if (!header
      || header.x + header.w > framebuffer.width
      || header.y + header.h > framebuffer.height) {
      this.drop();
      return;
    }
    const rgba = new Uint8ClampedArray(data, 12) as Uint8ClampedArray<ArrayBuffer>;
    const nextBytes = this.pendingBytes + rgba.byteLength;
    if (this.pending.length >= VNC_MAX_PENDING_RECTS || nextBytes > VNC_MAX_PENDING_FRAME_BYTES) {
      this.drop();
      return;
    }
    this.pending.push({ ...header, rgba });
    this.pendingBytes = nextBytes;
    this.receiveMs += this.now() - started;
  }

  /** Paint any pending frame now that the tab is visible again. */
  resume(): void {
    if (this.boundaryPending) this.schedule();
  }

  /** Forget queued pixels (DesktopSize, reconnect). */
  reset(): void {
    this.cancelScheduled();
    this.pending = [];
    this.pendingBytes = 0;
    this.dropUntilBoundary = false;
    this.boundaryPending = false;
    this.receiveMs = 0;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  /** True while an animation frame is scheduled (idle sessions keep none). */
  get scheduled(): boolean {
    return this.frameHandle !== null;
  }

  /** Stats since the previous call; the window resets on every read. */
  takeStats(): VncPaintStats {
    const stats: VncPaintStats = {
      framesPainted: this.framesPainted,
      avgPaintMs: this.paintedInWindow > 0 ? this.paintMsInWindow / this.paintedInWindow : 0,
      fullFrame: this.fullFrame,
    };
    this.paintedInWindow = 0;
    this.paintMsInWindow = 0;
    return stats;
  }

  private endFrame(): void {
    if (this.dropUntilBoundary) {
      // The frame lost pixels: ask the relay to repaint from its authoritative
      // framebuffer instead of acknowledging a partial frame.
      this.dropUntilBoundary = false;
      this.pending = [];
      this.pendingBytes = 0;
      this.boundaryPending = false;
      this.receiveMs = 0;
      this.host.requestFullRefresh();
      return;
    }
    this.boundaryPending = true;
    this.schedule();
  }

  private drop(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.receiveMs = 0;
    this.dropUntilBoundary = true;
  }

  private schedule(): void {
    if (this.frameHandle !== null || !this.host.isVisible()) return;
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.paint();
    });
  }

  private cancelScheduled(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private paint(): void {
    if (this.disposed || !this.boundaryPending) return;
    // A hidden tab keeps the frame (and withholds the ACK) until it is shown.
    if (!this.host.isVisible()) return;
    const ctx = this.host.getContext();
    if (!ctx) return;
    const frames = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.boundaryPending = false;
    const receiveMs = this.receiveMs;
    this.receiveMs = 0;

    const canvas = ctx.canvas;
    const size = this.host.framebufferSize();
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width || 1;
      canvas.height = size.height || 1;
    }
    const started = this.now();
    let failed = false;
    let pixels = 0;
    for (const frame of frames) {
      if (frame.rgba.length !== frame.w * frame.h * 4) {
        failed = true;
        continue;
      }
      try {
        ctx.putImageData(new ImageData(frame.rgba, frame.w, frame.h), frame.x, frame.y);
        pixels += frame.w * frame.h;
      } catch {
        failed = true;
      }
    }
    const paintMs = this.now() - started;

    if (failed) {
      this.host.requestFullRefresh();
      return;
    }
    if (frames.length > 0) {
      this.framesPainted += 1;
      this.paintedInWindow += 1;
      this.paintMsInWindow += paintMs;
      if (size.width > 0 && pixels >= size.width * size.height * 0.9) {
        this.fullFrame = { receiveMs, paintMs, pixels };
      }
    }
    this.host.sendAck();
  }
}

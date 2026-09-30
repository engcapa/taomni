import { describe, expect, it, vi } from "vitest";
import { VncFramePainter, type VncPainterHost } from "./vncFramePainter";

function rect(x: number, y: number, w: number, h: number): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + w * h * 4);
  const view = new DataView(buffer);
  view.setUint16(0, x);
  view.setUint16(2, y);
  view.setUint16(4, w);
  view.setUint16(6, h);
  return buffer;
}

class FakeImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}

function setup(visible = true) {
  if (typeof globalThis.ImageData === "undefined") {
    vi.stubGlobal("ImageData", FakeImageData);
  }
  const frames: Array<() => void> = [];
  const putImageData = vi.fn();
  const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
  const ctx = { canvas, putImageData } as unknown as CanvasRenderingContext2D;
  const state = { visible };
  const host: VncPainterHost = {
    getContext: () => ctx,
    framebufferSize: () => ({ width: 4, height: 2 }),
    isVisible: () => state.visible,
    sendAck: vi.fn(),
    requestFullRefresh: vi.fn(),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: vi.fn(),
    now: () => 0,
  };
  const painter = new VncFramePainter(host);
  const runFrames = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((callback) => callback());
  };
  return { painter, host, putImageData, canvas, frames, runFrames, state };
}

describe("VncFramePainter", () => {
  it("schedules no animation frame while the session is idle", () => {
    const { painter, frames } = setup();
    painter.receive(rect(0, 0, 2, 2));
    expect(frames).toHaveLength(0);
    expect(painter.scheduled).toBe(false);
  });

  it("paints a whole frame in one animation frame and ACKs after painting", () => {
    const { painter, host, putImageData, canvas, frames, runFrames } = setup();
    painter.receive(rect(0, 0, 2, 2));
    painter.receive(rect(2, 0, 2, 2));
    painter.receive(new ArrayBuffer(0));
    expect(frames).toHaveLength(1);
    expect(host.sendAck).not.toHaveBeenCalled();
    runFrames();
    expect(putImageData).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(4);
    expect(host.sendAck).toHaveBeenCalledTimes(1);
    expect(painter.scheduled).toBe(false);
    expect(painter.takeStats().fullFrame?.pixels).toBe(8);
  });

  it("keeps the frame and its ACK while hidden, then paints on resume", () => {
    const { painter, host, frames, runFrames, state } = setup(false);
    painter.receive(rect(0, 0, 4, 2));
    painter.receive(new ArrayBuffer(0));
    expect(frames).toHaveLength(0);
    state.visible = true;
    painter.resume();
    runFrames();
    expect(host.sendAck).toHaveBeenCalledTimes(1);
  });

  it("drops a frame whose rectangle falls outside the framebuffer and asks for a refresh", () => {
    const { painter, host, putImageData, runFrames } = setup();
    painter.receive(rect(3, 0, 2, 2));
    painter.receive(new ArrayBuffer(0));
    runFrames();
    expect(putImageData).not.toHaveBeenCalled();
    expect(host.sendAck).not.toHaveBeenCalled();
    expect(host.requestFullRefresh).toHaveBeenCalledTimes(1);
  });

  it("forgets queued pixels on reset", () => {
    const { painter, host, runFrames } = setup();
    painter.receive(rect(0, 0, 2, 2));
    painter.receive(new ArrayBuffer(0));
    painter.reset();
    runFrames();
    expect(host.sendAck).not.toHaveBeenCalled();
  });
});

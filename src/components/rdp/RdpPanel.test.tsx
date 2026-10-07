import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OUT_FRAME, OUT_FRAME_END, rdpConnect, rdpDisconnect } from "../../lib/rdp";
import { useRdpStore, type RdpConnectionState } from "../../stores/rdpStore";
import { DEFAULT_RDP_OPTIONS } from "../../types/rdp";
import RdpPanel from "./RdpPanel";

vi.mock("../../lib/rdp", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/rdp")>(),
  rdpConnect: vi.fn(),
  rdpDisconnect: vi.fn(),
}));

const CONNECTED: RdpConnectionState = {
  status: "connected",
  sessionId: "rdp-session",
  wsPort: 41000,
  width: 1920,
  height: 1080,
  protocol: "TLS",
  serverName: "windows-host",
  error: null,
  stage: null,
};

describe("RdpPanel pointer rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRdpStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function renderPanel() {
    return render(
      <RdpPanel
        tabId="rdp-tab"
        host="windows.example.test"
        port={3389}
        options={DEFAULT_RDP_OPTIONS}
        visible
      />,
    );
  }

  it("uses a local WebView cursor so pointer movement is not gated by remote frames", () => {
    useRdpStore.setState({ connections: { "rdp-tab": CONNECTED } });

    renderPanel();

    expect(screen.getByTestId("rdp-canvas")).toHaveStyle({ cursor: "default" });
  });

  it("keeps a local cursor while the RDP desktop is disconnected", () => {
    renderPanel();

    expect(screen.getByTestId("rdp-canvas")).toHaveStyle({ cursor: "default" });
  });
});

class TestRdpSocket {
  static OPEN = 1;
  static instances: TestRdpSocket[] = [];
  readyState = TestRdpSocket.OPEN;
  binaryType = "";
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });

  constructor() {
    TestRdpSocket.instances.push(this);
  }

  connected(width: number, height: number) {
    this.onmessage?.({
      data: JSON.stringify({ type: "connected", width, height, protocol: "TLS", server_name: "xrdp" }),
    });
  }

  whitePixel() {
    const frame = new ArrayBuffer(13);
    const view = new DataView(frame);
    view.setUint8(0, OUT_FRAME);
    view.setUint16(1, 280);
    view.setUint16(3, 240);
    view.setUint16(5, 1);
    view.setUint16(7, 1);
    new Uint8Array(frame, 9).set([255, 255, 255, 255]);
    this.onmessage?.({ data: frame });
    this.onmessage?.({ data: Uint8Array.of(OUT_FRAME_END).buffer });
  }
}

// jsdom does not rasterize canvas. Model the platform rule that assigning either
// dimension (including the same value) clears the bitmap, through attributes
// as well as properties. Observe pixels independently of React's update order.
function observeCanvasPixel(canvas: HTMLCanvasElement) {
  let pixel = [0, 0, 0, 0];
  const clear = () => { pixel = [0, 0, 0, 0]; };
  for (const dimension of ["width", "height"] as const) {
    const setter = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!.set!;
    vi.spyOn(canvas, dimension, "set").mockImplementation((value: number) => {
      setter.call(canvas, value);
      clear();
    });
  }
  const setAttribute = canvas.setAttribute.bind(canvas);
  vi.spyOn(canvas, "setAttribute").mockImplementation((name, value) => {
    setAttribute(name, value);
    if (name === "width" || name === "height") clear();
  });
  vi.spyOn(canvas, "getContext").mockReturnValue({
    putImageData: (image: ImageData, x: number, y: number) => {
      if (x === 280 && y === 240) pixel = Array.from(image.data.slice(0, 4));
    },
  } as unknown as CanvasRenderingContext2D);
  return () => pixel;
}

describe("RdpPanel framebuffer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestRdpSocket.instances = [];
    vi.mocked(rdpConnect).mockClear();
    vi.mocked(rdpDisconnect).mockClear();
    vi.stubGlobal("WebSocket", TestRdpSocket);
    vi.stubGlobal("ImageData", class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    vi.mocked(rdpConnect).mockResolvedValue({ session_id: "rdp-session", ws_port: 41000, ws_token: "token" });
    vi.mocked(rdpDisconnect).mockResolvedValue();
    useRdpStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function connectPanel(width: number, height: number) {
    render(<RdpPanel tabId="rdp-tab" host="xrdp.test" port={3389} options={DEFAULT_RDP_OPTIONS} visible />);
    const canvas = screen.getByTestId("rdp-canvas") as HTMLCanvasElement;
    const readPixel = observeCanvasPixel(canvas);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(TestRdpSocket.instances).toHaveLength(1);
    const socket = TestRdpSocket.instances[0];
    act(() => { socket.connected(width, height); });
    act(() => { socket.whitePixel(); });
    expect([canvas.width, canvas.height]).toEqual([width, height]);
    expect(readPixel()).toEqual([255, 255, 255, 255]);
    return { canvas, readPixel, socket };
  }

  it("draws initial frames and retains them on a same-size reactivation", async () => {
    const { readPixel, socket } = await connectPanel(994, 750);
    act(() => { socket.connected(994, 750); });
    expect(readPixel()).toEqual([255, 255, 255, 255]);
  });

  it("releases an errored relay and retries transient failures at most three times", async () => {
    render(<RdpPanel tabId="rdp-tab" host="loopback.test" port={3389} options={DEFAULT_RDP_OPTIONS} visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    for (let attempt = 0; attempt < 4; attempt++) {
      const socket = TestRdpSocket.instances[attempt];
      act(() => { socket.onmessage?.({ data: JSON.stringify({
        type: "error", retryable: true,
        message: "rdp negotiation failed (transient transport): Connection reset by peer",
      }) }); });
      expect(socket.close).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(rdpConnect).toHaveBeenCalledTimes(Math.min(attempt + 2, 4));
    }
    expect(rdpDisconnect).toHaveBeenCalledTimes(4);
  });

  it("closes an authentication failure without retrying or replacing its diagnostic", async () => {
    render(<RdpPanel tabId="rdp-tab" host="loopback.test" port={3389} options={DEFAULT_RDP_OPTIONS} visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const socket = TestRdpSocket.instances[0];
    act(() => { socket.onmessage?.({ data: JSON.stringify({
      type: "error", retryable: false, message: "CredSSP authentication rejected",
    }) }); });
    expect(socket.close).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(rdpConnect).toHaveBeenCalledTimes(1);
    expect(useRdpStore.getState().connections['rdp-tab'].error).toBe("CredSSP authentication rejected");
  });

  it.each([
    ["fullscreen", 994, 750, 1492, 1030],
    ["restore", 1492, 1030, 994, 750],
  ])("preserves the first %s frame when it arrives before React commits the new dimensions", async (_, width, height, nextWidth, nextHeight) => {
    const { canvas, readPixel, socket } = await connectPanel(width, height);
    act(() => {
      socket.connected(nextWidth, nextHeight);
      socket.whitePixel();
      expect(readPixel()).toEqual([255, 255, 255, 255]);
    });
    expect([canvas.width, canvas.height]).toEqual([nextWidth, nextHeight]);
    expect(readPixel()).toEqual([255, 255, 255, 255]);
  });
});

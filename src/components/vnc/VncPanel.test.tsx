import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useVncStore, type VncConnectionState } from "../../stores/vncStore";
import VncPanel from "./VncPanel";

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

const CONNECTED: VncConnectionState = {
  status: "connected",
  sessionId: "vnc-session",
  wsPort: 41000,
  width: 1920,
  height: 1080,
  name: "windows-host",
  protocol: "RFB 3.8",
  security: "VNC Authentication",
  encrypted: false,
  error: null,
};

describe("VncPanel pointer rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        return Promise.resolve({
          session_id: "vnc-session",
          ws_port: 41000,
          ws_token: "relay-token",
          width: 1920,
          height: 1080,
          name: "windows-host",
        });
      }
      return Promise.resolve();
    });
    useVncStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.invoke.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("hides the local cursor until the server confirms client-side cursor support", () => {
    useVncStore.setState({ connections: { "vnc-tab": CONNECTED } });

    render(
      <VncPanel
        tabId="vnc-tab"
        host="windows.example.test"
        port={5900}
        visible
      />,
    );

    expect(screen.getByTestId("vnc-canvas")).toHaveStyle({ cursor: "none" });
  });

  it("uses a local cursor after PointerPos while preserving a later cursor shape", async () => {
    render(
      <VncPanel
        tabId="vnc-tab"
        host="windows.example.test"
        port={5900}
        visible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.onmessage?.({
        data: '{"type":"connected","width":1920,"height":1080,"name":"fixture","protocol":"3.8","security":"VNCAuth","encrypted":false}',
      } as MessageEvent);
      socket.onmessage?.({ data: '{"type":"pointer_pos","x":100,"y":200}' } as MessageEvent);
    });
    expect(screen.getByTestId("vnc-canvas")).toHaveStyle({ cursor: "default" });

    act(() => {
      socket.onmessage?.({
        data: '{"type":"cursor","visible":true,"hotspot_x":0,"hotspot_y":0,"width":1,"height":1,"png_base64":"iVBORw0KGgo="}',
      } as MessageEvent);
      socket.onmessage?.({ data: '{"type":"pointer_pos","x":101,"y":201}' } as MessageEvent);
    });
    expect(screen.getByTestId("vnc-canvas").style.cursor).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

});

function sentMessages(socket: MockWebSocket): Array<{ kind: "key"; down: boolean; keysym: number } | { kind: "pointer"; buttons: number; x: number; y: number }> {
  return socket.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is ArrayBuffer => payload instanceof ArrayBuffer)
    .map((payload) => {
      const view = new DataView(payload);
      if (view.getUint8(0) === 2) {
        return { kind: "key" as const, down: view.getUint8(1) === 1, keysym: view.getUint32(2) };
      }
      if (view.getUint8(0) === 3) {
        return { kind: "pointer" as const, buttons: view.getUint8(1), x: view.getUint16(2), y: view.getUint16(4) };
      }
      return null;
    })
    .filter((message): message is NonNullable<typeof message> => message !== null);
}

async function renderConnected(props: Partial<Parameters<typeof VncPanel>[0]> = {}) {
  render(
    <VncPanel tabId="vnc-tab" host="windows.example.test" port={5900} visible {...props} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const socket = MockWebSocket.instances[0];
  act(() => {
    socket.onmessage?.({
      data: '{"type":"connected","width":1920,"height":1080,"name":"fixture","protocol":"3.8","security":"VNCAuth","encrypted":false}',
    } as MessageEvent);
  });
  const canvas = screen.getByTestId("vnc-canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  act(() => canvas.focus());
  socket.send.mockClear();
  return { socket, canvas };
}

describe("VncPanel RealVNC-aligned input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        return Promise.resolve({ session_id: "vnc-session", ws_port: 41000, ws_token: "relay-token", width: 1920, height: 1080, name: "windows-host" });
      }
      return Promise.resolve("");
    });
    useVncStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.invoke.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not move the remote pointer to 0,0 when the window loses focus", async () => {
    const { socket } = await renderConnected();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(sentMessages(socket).filter((message) => message.kind === "pointer")).toEqual([]);
  });

  it("sends a right click immediately instead of waiting for a clipboard sync", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      fireEvent.pointerDown(canvas, { button: 2, buttons: 2, clientX: 480, clientY: 270, pointerId: 7 });
    });
    const pointers = sentMessages(socket).filter((message) => message.kind === "pointer");
    expect(pointers[0]).toEqual({ kind: "pointer", buttons: 4, x: 960, y: 540 });
  });

  it("turns a mouse wheel notch into one press/release pair", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: 480, clientY: 270, bubbles: true, cancelable: true }));
    });
    const pointers = sentMessages(socket).filter((message) => message.kind === "pointer");
    expect(pointers.map((message) => message.kind === "pointer" && message.buttons)).toEqual([0x10, 0]);
  });

  it("sends moves from pointerrawupdate and ignores the frame-aligned duplicate", async () => {
    (window as unknown as Record<string, unknown>).onpointerrawupdate = null;
    try {
      const { socket, canvas } = await renderConnected();
      act(() => {
        canvas.dispatchEvent(new MouseEvent("pointerrawupdate", { clientX: 240, clientY: 135, bubbles: true }));
        fireEvent.pointerMove(canvas, { clientX: 240, clientY: 135, pointerId: 1 });
      });
      expect(sentMessages(socket).filter((message) => message.kind === "pointer")).toEqual([
        { kind: "pointer", buttons: 0, x: 480, y: 270 },
      ]);
    } finally {
      delete (window as unknown as Record<string, unknown>).onpointerrawupdate;
    }
  });

  it("opens the session menu on F8 without sending the key", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
      fireEvent.keyUp(canvas, { key: "F8", code: "F8" });
    });
    expect(screen.getByTestId("vnc-menu-send-cad")).toBeInTheDocument();
    expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([]);
  });

  it("sends Ctrl+Alt+Del from the session menu as ordered press and release", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("vnc-menu-send-cad"));
    });
    expect(sentMessages(socket)).toEqual([
      { kind: "key", down: true, keysym: 0xffe3 },
      { kind: "key", down: true, keysym: 0xffe9 },
      { kind: "key", down: true, keysym: 0xffff },
      { kind: "key", down: false, keysym: 0xffff },
      { kind: "key", down: false, keysym: 0xffe9 },
      { kind: "key", down: false, keysym: 0xffe3 },
    ]);
  });
});

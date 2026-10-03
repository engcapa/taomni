import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  window: { current: null as Record<string, unknown> | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (!mocks.window.current) throw new Error("no Tauri window in this test");
    return mocks.window.current;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return Promise.resolve(() => {
      if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name);
    });
  }),
}));

import { useVncStore, type VncConnectionState } from "../../stores/vncStore";
import VncPanel from "./VncPanel";
import { DEFAULT_VNC_VIEWER_OPTIONS } from "../../lib/vncOptions";
import { TabActionSlotProvider } from "../tabbar/TabActionSlot";

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

  it("offers unified current-window capture from a detached VNC window", async () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    try {
      render(
        <TabActionSlotProvider slot={slot}>
          <VncPanel
            tabId="vnc-tab"
            host="windows.example.test"
            port={5900}
            visible
            detachedWindowControls={{ onReattach: vi.fn(), onToggleOsFullscreen: vi.fn(), osFullscreen: false }}
          />
        </TabActionSlotProvider>,
      );
      fireEvent.click(screen.getByTestId("system-screenshot-delay-toggle"));
      await act(async () => fireEvent.click(screen.getByTestId("system-screenshot-current-window")));
      expect(mocks.invoke).toHaveBeenCalledWith("screenshot_open_overlay", { displayId: null, includeCurrentWindow: true });
      expect(screen.queryByTestId("capture-menu")).not.toBeInTheDocument();
    } finally {
      slot.remove();
    }
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

function sentText(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is string => typeof payload === "string")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

async function renderConnected(
  props: Partial<Parameters<typeof VncPanel>[0]> = {},
  connected: Record<string, unknown> = {},
) {
  render(
    <VncPanel tabId="vnc-tab" host="windows.example.test" port={5900} visible {...props} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const socket = MockWebSocket.instances[0];
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "connected", width: 1920, height: 1080, name: "fixture", protocol: "3.8", security: "VNCAuth",
        encrypted: false, ...connected,
      }),
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

  it("reports the canvas to the relay's native sampler while the pointer rests over it", async () => {
    const { socket, canvas } = await renderConnected({}, { native_pointer: true });
    act(() => {
      fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 240, clientY: 135, pointerId: 1 });
    });
    expect(sentText(socket).filter((message) => message.type === "native_pointer")).toEqual([
      { type: "native_pointer", on: true, left: 0, top: 0, width: 960, height: 540, dpr: 1, fb_width: 1920, fb_height: 1080 },
    ]);
    // The panel keeps sending its own moves; the relay drops the late copies.
    act(() => {
      fireEvent.pointerMove(canvas, { clientX: 240, clientY: 135, pointerId: 1 });
    });
    expect(sentMessages(socket).filter((message) => message.kind === "pointer")).toEqual([
      { kind: "pointer", buttons: 0, x: 480, y: 270 },
    ]);
    act(() => {
      fireEvent.pointerLeave(canvas, { pointerId: 1 });
      fireEvent.pointerLeave(canvas, { pointerId: 1 });
    });
    expect(sentText(socket).filter((message) => message.type === "native_pointer").slice(1)).toEqual([
      { type: "native_pointer", on: false },
    ]);
  });

  it("stops native sampling when the window loses focus", async () => {
    const { socket, canvas } = await renderConnected({}, { native_pointer: true });
    act(() => {
      fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 240, clientY: 135, pointerId: 1 });
      window.dispatchEvent(new Event("blur"));
    });
    expect(sentText(socket).filter((message) => message.type === "native_pointer").map((message) => message.on))
      .toEqual([true, false]);
  });

  it("keeps the WebView pointer path when the relay offers no native sampling", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 240, clientY: 135, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 240, clientY: 135, pointerId: 1 });
    });
    expect(sentText(socket).filter((message) => message.type === "native_pointer")).toEqual([]);
    expect(sentMessages(socket).filter((message) => message.kind === "pointer")).toEqual([
      { kind: "pointer", buttons: 0, x: 480, y: 270 },
    ]);
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

function connectCalls() {
  return mocks.invoke.mock.calls.filter(([command]) => command === "vnc_connect");
}

describe("VncPanel connection lifecycle (VNC-SESS-003)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    useVncStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.invoke.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const structured = (code: string, stage: string, retryable: boolean, message: string) =>
    new Error(JSON.stringify({ code, stage, retryable, message }));

  it("asks before an unencrypted connection and retries with the confirmation", async () => {
    let calls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(structured("unencrypted-confirmation-required", "security", false, "unencrypted connection requires confirmation"));
        }
        return Promise.resolve({ session_id: "s", ws_port: 41000, ws_token: "t", width: 0, height: 0, name: "" });
      }
      return Promise.resolve("");
    });
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connectCalls()[0][1]).toMatchObject({ allowUnencrypted: false });
    expect(screen.getByTestId("vnc-overlay-unencrypted")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("vnc-unencrypted-continue"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connectCalls()).toHaveLength(2);
    expect(connectCalls()[1][1]).toMatchObject({ allowUnencrypted: true });
  });

  it("shows the authentication form after a failed attempt and reconnects with the typed password", async () => {
    let calls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        calls += 1;
        if (calls === 1) return Promise.reject(structured("authentication-failed", "authentication", false, "authentication failed (result=1)"));
        return Promise.resolve({ session_id: "s", ws_port: 41000, ws_token: "t", width: 0, height: 0, name: "" });
      }
      return Promise.resolve("");
    });
    const onCredentialsChange = vi.fn();
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} password="old" visible onCredentialsChange={onCredentialsChange} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("vnc-auth-error")).toHaveTextContent("authentication failed");
    fireEvent.change(screen.getByTestId("vnc-auth-password"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByTestId("vnc-auth-remember"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("vnc-auth-ok"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connectCalls()[1][1]).toMatchObject({ password: "new-secret" });
    expect(onCredentialsChange).toHaveBeenCalledWith({ username: "", password: "new-secret" });
  });

  it("asks for missing credentials in the session without an error and keeps the warning confirmation", async () => {
    let calls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(structured("unencrypted-confirmation-required", "security", false, "unencrypted connection requires confirmation"));
        }
        if (calls === 2) {
          return Promise.reject(structured("credentials-required", "authentication", false, "credentials required: the server asks for a password"));
        }
        return Promise.resolve({ session_id: "s", ws_port: 41000, ws_token: "t", width: 0, height: 0, name: "" });
      }
      return Promise.resolve("");
    });
    // A saved session without a password: the panel connects first (DEC-VNC-21).
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} username="ops" visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connectCalls()[0][1]).toMatchObject({ password: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId("vnc-unencrypted-continue"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("vnc-auth-password")).toBeInTheDocument();
    expect(screen.queryByTestId("vnc-auth-error")).toBeNull();
    expect(screen.getByTestId("vnc-auth-username")).toHaveValue("ops");
    fireEvent.change(screen.getByTestId("vnc-auth-password"), { target: { value: "secret12" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("vnc-auth-ok"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The retry carries the password and does not ask the warning again.
    expect(connectCalls()).toHaveLength(3);
    expect(connectCalls()[2][1]).toMatchObject({ password: "secret12", allowUnencrypted: true });
    expect(screen.queryByTestId("vnc-overlay-unencrypted")).toBeNull();
  });

  it("asks the warning again after a wrong password", async () => {
    let calls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        calls += 1;
        if (calls === 1) return Promise.reject(structured("authentication-failed", "authentication", false, "authentication failed (result=1)"));
        return Promise.reject(structured("unencrypted-confirmation-required", "security", false, "unencrypted connection requires confirmation"));
      }
      return Promise.resolve("");
    });
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} password="wrong" visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByTestId("vnc-auth-password"), { target: { value: "secret12" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("vnc-auth-ok"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connectCalls()[1][1]).toMatchObject({ allowUnencrypted: false });
  });

  it("Stop cancels the attempt in flight", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") return new Promise(() => {});
      return Promise.resolve(true);
    });
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const attemptId = (connectCalls()[0][1] as { attemptId: string }).attemptId;
    expect(attemptId).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByTestId("vnc-connect-stop"));
    });
    expect(mocks.invoke).toHaveBeenCalledWith("vnc_cancel_connect", { attemptId });
    expect(screen.getByTestId("vnc-overlay-disconnected")).toBeInTheDocument();
  });

  it("keeps reconnecting a dropped session with backoff", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        return Promise.resolve({ session_id: "s", ws_port: 41000, ws_token: "t", width: 0, height: 0, name: "" });
      }
      return Promise.resolve("");
    });
    render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let round = 0; round < 4; round += 1) {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        socket.onmessage?.({
          data: JSON.stringify({ type: "disconnected", code: "connection-lost", stage: "runtime", retryable: true, reason: "lost" }),
        } as MessageEvent);
      });
      expect(screen.getByTestId("vnc-overlay-reconnecting")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
    }
    // Four drops, four automatic reconnects (the old policy gave up after three).
    expect(connectCalls()).toHaveLength(5);
  });
});

describe("VncPanel viewer options (VNC-CLIP-001, VNC-PERF-004, VNC-INPUT-003)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        return Promise.resolve({ session_id: "vnc-session", ws_port: 41000, ws_token: "relay-token", width: 1920, height: 1080, name: "windows-host" });
      }
      return Promise.resolve("local text");
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

  it("does not push the local clipboard when the session connects", async () => {
    const { socket } = await renderConnected();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const texts = socket.send.mock.calls.map(([payload]) => payload).filter((payload) => typeof payload === "string");
    expect(texts.filter((text) => String(text).includes("ext_clipboard"))).toEqual([]);
  });

  describe("VNC-CLIP-001 clipboard timing", () => {
    let local = "baseline";
    beforeEach(() => {
      local = "baseline";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: vi.fn(async () => local),
          writeText: vi.fn(async (text: string) => {
            local = text;
          }),
        },
      });
    });
    afterEach(() => {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    });

    const clipboardTexts = (socket: MockWebSocket) =>
      sentText(socket).filter((message) => message.type === "ext_clipboard").map((message) => message.text);

    it("sends a local change once when the pointer comes back to the desktop", async () => {
      const { socket, canvas } = await renderConnected();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      local = "copied elsewhere";
      await act(async () => {
        fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 10, clientY: 10, pointerId: 1 });
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        fireEvent.pointerLeave(canvas, { pointerId: 1 });
        await vi.advanceTimersByTimeAsync(300);
        fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 10, clientY: 10, pointerId: 1 });
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(clipboardTexts(socket)).toEqual(["copied elsewhere"]);
    });

    it("does not echo the server's clipboard back", async () => {
      const { socket, canvas } = await renderConnected();
      await act(async () => {
        socket.onmessage?.({ data: '{"type":"clipboard","text":"from the server"}' } as MessageEvent);
        await vi.advanceTimersByTimeAsync(10);
      });
      // The local clipboard now holds the server's text.
      local = "from the server";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        fireEvent.pointerEnter(canvas, { buttons: 0, clientX: 10, clientY: 10, pointerId: 1 });
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(clipboardTexts(socket)).toEqual([]);
    });

    it("pastes an external Linux clipboard when WebKit reports an empty value", async () => {
      const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
      const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
      vi.stubGlobal("__TAURI_INTERNALS__", {});
      const defaultInvoke = mocks.invoke.getMockImplementation();
      mocks.invoke.mockImplementation((command: string, args?: unknown) => {
        if (command === "clipboard_read_text") return Promise.resolve("copied externally");
        return defaultInvoke?.(command, args);
      });
      local = "";
      try {
        const { socket, canvas } = await renderConnected();
        await act(async () => {
          fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
          fireEvent.keyUp(canvas, { key: "v", code: "KeyV", ctrlKey: true });
          await vi.advanceTimersByTimeAsync(300);
        });
        expect(clipboardTexts(socket)).toEqual(["copied externally"]);
        expect(mocks.invoke).toHaveBeenCalledWith("clipboard_read_text");
      } finally {
        platform.mockRestore();
        userAgent.mockRestore();
      }
    });

    it("types the clipboard as keystrokes from the session menu", async () => {
      const { socket, canvas } = await renderConnected();
      local = "Ab1\n";
      act(() => {
        fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-menu-send-clipboard-keys"));
        await vi.advanceTimersByTimeAsync(100);
      });
      const presses = sentMessages(socket)
        .filter((message) => message.kind === "key" && message.down)
        .map((message) => message.kind === "key" && message.keysym);
      expect(presses).toEqual([0x41, 0x62, 0x31, 0xff0d]);
    });
  });

  it("sends the picture quality chosen in the session menu", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
    });
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("vnc-menu-quality"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("vnc-quality-low"));
    });
    const binary = socket.send.mock.calls
      .map(([payload]) => payload)
      .filter((payload): payload is ArrayBuffer => payload instanceof ArrayBuffer)
      .map((payload) => Array.from(new Uint8Array(payload)));
    expect(binary).toContainEqual([5, 3]);
  });

  it("honours a custom session menu key", async () => {
    const { socket, canvas } = await renderConnected({
      viewerOptions: { ...DEFAULT_VNC_VIEWER_OPTIONS, menuKey: "F9" },
    });
    act(() => {
      fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
      fireEvent.keyUp(canvas, { key: "F8", code: "F8" });
    });
    expect(screen.queryByTestId("vnc-menu-send-cad")).toBeNull();
    expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
      { kind: "key", down: true, keysym: 0xffc5 },
      { kind: "key", down: false, keysym: 0xffc5 },
    ]);
    act(() => {
      fireEvent.keyDown(canvas, { key: "F9", code: "F9" });
    });
    expect(screen.getByTestId("vnc-menu-send-cad")).toBeInTheDocument();
  });

  it("releases the keysym a key pressed and drops key-ups whose press went elsewhere", async () => {
    const { socket, canvas } = await renderConnected();
    act(() => {
      // Esc closing the session menu: only its key-up reaches the canvas.
      fireEvent.keyUp(canvas, { key: "Escape", code: "Escape" });
      fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
      fireEvent.keyUp(canvas, { key: "A", code: "KeyA", shiftKey: true });
    });
    expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
      { kind: "key", down: true, keysym: 0x61 },
      { kind: "key", down: false, keysym: 0x61 },
    ]);
  });

  it("drops the synthetic Ctrl that Windows sends with AltGr", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    try {
      const { socket, canvas } = await renderConnected();
      const key = (type: string, init: KeyboardEventInit) =>
        canvas.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
      act(() => {
        key("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
        key("keydown", { key: "AltGraph", code: "AltRight", ctrlKey: true, altKey: true });
        key("keydown", { key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
        key("keyup", { key: "@", code: "KeyQ" });
        key("keyup", { key: "Control", code: "ControlLeft" });
        key("keyup", { key: "AltGraph", code: "AltRight" });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
        { kind: "key", down: true, keysym: 0xfe03 },
        { kind: "key", down: true, keysym: 0x40 },
        { kind: "key", down: false, keysym: 0x40 },
        { kind: "key", down: false, keysym: 0xfe03 },
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("sends Ctrl before a key passed through by the special-key hook (Ctrl+Esc)", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };
    tauri.__TAURI_INTERNALS__ = {};
    try {
      const { socket, canvas } = await renderConnected();
      act(() => {
        window.dispatchEvent(new Event("focus"));
        fireEvent.focus(canvas);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.invoke).toHaveBeenCalledWith("vnc_set_special_key_capture", { enabled: true });
      const special = mocks.listeners.get("vnc-special-key");
      expect(special).toBeDefined();
      act(() => {
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true, bubbles: true, cancelable: true }));
        // Esc arrives from the hook 40 ms later, inside the AltGr pairing wait.
        vi.advanceTimersByTime(40);
        special?.({ payload: { code: "Escape", down: true } });
        special?.({ payload: { code: "Escape", down: false } });
        canvas.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
        { kind: "key", down: true, keysym: 0xffe3 },
        { kind: "key", down: true, keysym: 0xff1b },
        { kind: "key", down: false, keysym: 0xff1b },
        { kind: "key", down: false, keysym: 0xffe3 },
      ]);
    } finally {
      delete tauri.__TAURI_INTERNALS__;
      mocks.listeners.clear();
      platform.mockRestore();
    }
  });

  it("sends the character a dead key composes, not the bare letter", async () => {
    const { socket, canvas } = await renderConnected();
    const key = (type: string, init: KeyboardEventInit) => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      canvas.dispatchEvent(event);
      return event;
    };
    let deadDown: KeyboardEvent | null = null;
    let letterDown: KeyboardEvent | null = null;
    act(() => {
      // German ^ then e: the OS composes and reports "ê" only as keypress.
      deadDown = key("keydown", { key: "Dead", code: "Backquote" });
      key("keyup", { key: "Dead", code: "Backquote" });
      letterDown = key("keydown", { key: "e", code: "KeyE" });
      key("keypress", { key: "ê", code: "KeyE", charCode: 0xea });
      key("keyup", { key: "e", code: "KeyE" });
      // Ctrl+C right after a dead key is still a shortcut.
      key("keydown", { key: "Dead", code: "Backquote" });
      key("keydown", { key: "Control", code: "ControlRight", ctrlKey: true });
      key("keydown", { key: "c", code: "KeyC", ctrlKey: true });
      key("keyup", { key: "c", code: "KeyC", ctrlKey: true });
      key("keyup", { key: "Control", code: "ControlRight" });
    });
    // The OS needs both keydowns to compose: neither may be default-prevented.
    expect(deadDown!.defaultPrevented).toBe(false);
    expect(letterDown!.defaultPrevented).toBe(false);
    expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
      { kind: "key", down: true, keysym: 0xea },
      { kind: "key", down: false, keysym: 0xea },
      { kind: "key", down: true, keysym: 0xffe3 },
      { kind: "key", down: true, keysym: 0x63 },
      { kind: "key", down: false, keysym: 0x63 },
      { kind: "key", down: false, keysym: 0xffe3 },
    ]);
  });

  it("enters screen full screen without Tauri's resize-border window and restores the window", async () => {
    const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };
    tauri.__TAURI_INTERNALS__ = {};
    const calls: string[] = [];
    const state = { maximized: true, fullscreen: false, resizable: true };
    mocks.window.current = {
      isMaximized: async () => state.maximized,
      isFullscreen: async () => state.fullscreen,
      isResizable: async () => state.resizable,
      unmaximize: async () => { calls.push("unmaximize"); state.maximized = false; },
      maximize: async () => { calls.push("maximize"); state.maximized = true; },
      setResizable: async (value: boolean) => { calls.push(`setResizable(${value})`); state.resizable = value; },
      setFullscreen: async (value: boolean) => { calls.push(`setFullscreen(${value})`); state.fullscreen = value; },
    };
    try {
      const { canvas } = await renderConnected();
      act(() => {
        fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-menu-fullscreen"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("vnc-panel").dataset.vncFullscreen).toBe("true");
      expect(calls).toEqual(["unmaximize", "setResizable(false)", "setFullscreen(true)"]);
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-fs-exit"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("vnc-panel").dataset.vncFullscreen).toBe("false");
      expect(calls.slice(3)).toEqual(["setFullscreen(false)", "setResizable(true)", "maximize"]);
    } finally {
      delete tauri.__TAURI_INTERNALS__;
      mocks.window.current = null;
    }
  });

  it("still sends a plain Ctrl press on Windows", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    try {
      const { socket, canvas } = await renderConnected();
      act(() => {
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true, bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      act(() => {
        canvas.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      });
      expect(sentMessages(socket).filter((message) => message.kind === "key")).toEqual([
        { kind: "key", down: true, keysym: 0xffe3 },
        { kind: "key", down: false, keysym: 0xffe3 },
      ]);
    } finally {
      platform.mockRestore();
    }
  });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVncStore } from "../../../../stores/vncStore";
import { TabActionSlotProvider } from "../../../tabbar/TabActionSlot";
import VncPanel from "../../VncPanel";
import { CONNECTED, MockWebSocket, mocks, renderConnected, sentMessages, sentText } from "./harness";

export function registerVncPanelLayout1Cases() {

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
}

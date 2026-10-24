import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VNC_VIEWER_OPTIONS } from "../../../../lib/vncOptions";
import { useVncStore } from "../../../../stores/vncStore";
import { MockWebSocket, mocks, renderConnected, sentMessages, sentText } from "./harness";

export function registerVncPanelLayout3Cases() {

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
        // Platform detection joins navigator.platform with the userAgent; pin
        // both so a Windows host still resolves to the Linux branch.
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
      const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown; };
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
      const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown; };
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
}

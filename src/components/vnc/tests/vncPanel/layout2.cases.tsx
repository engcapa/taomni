import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVncStore } from "../../../../stores/vncStore";
import VncPanel from "../../VncPanel";
import { MockWebSocket, connectCalls, mocks } from "./harness";

export function registerVncPanelLayout2Cases() {

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

    it("keeps the accepted unencrypted warning across an automatic reconnect", async () => {
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
          if (calls === 3) {
            // A slow Apple Remote Desktop login expires the authentication
            // deadline; AutoReconnect retries the connection the user approved.
            return Promise.reject(structured("authentication-timeout", "authentication", true, "VNC authentication timed out while waiting for the security result"));
          }
          return Promise.resolve({ session_id: "s", ws_port: 41000, ws_token: "t", width: 0, height: 0, name: "" });
        }
        return Promise.resolve("");
      });
      render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} username="ops" visible />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-unencrypted-continue"));
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByTestId("vnc-auth-password"), { target: { value: "secret12" } });
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-auth-ok"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(connectCalls()).toHaveLength(3);
      expect(connectCalls()[2][1]).toMatchObject({ allowUnencrypted: true });
      // The timed-out attempt schedules AutoReconnect without re-asking.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("vnc-overlay-reconnecting")).toBeInTheDocument();
      expect(screen.queryByTestId("vnc-overlay-unencrypted")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(connectCalls()).toHaveLength(4);
      expect(connectCalls()[3][1]).toMatchObject({ allowUnencrypted: true });
      expect(screen.queryByTestId("vnc-overlay-unencrypted")).toBeNull();
    });

    it("Stop cancels the attempt in flight", async () => {
      mocks.invoke.mockImplementation((command: string) => {
        if (command === "vnc_connect") return new Promise(() => { });
        return Promise.resolve(true);
      });
      render(<VncPanel tabId="vnc-tab" host="h.test" port={5900} visible />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const attemptId = (connectCalls()[0][1] as { attemptId: string; }).attemptId;
      expect(attemptId).toBeTruthy();
      act(() => {
        fireEvent.click(screen.getByTestId("vnc-connect-stop"));
      });
      expect(mocks.invoke).toHaveBeenCalledWith("vnc_cancel_connect", { attemptId });
      expect(screen.getByTestId("vnc-overlay-disconnected")).toBeInTheDocument();
    });

    it("asks the unencrypted warning again when the user reconnects manually", async () => {
      let calls = 0;
      mocks.invoke.mockImplementation((command: string) => {
        if (command === "vnc_connect") {
          calls += 1;
          if (calls === 1 || calls === 3) {
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
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-unencrypted-continue"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(connectCalls()).toHaveLength(2);
      // The fixture drops the connection; AutoReconnect offers a manual retry.
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        socket.onmessage?.({
          data: JSON.stringify({ type: "disconnected", code: "connection-lost", stage: "runtime", retryable: true, reason: "lost" }),
        } as MessageEvent);
      });
      expect(screen.getByTestId("vnc-overlay-reconnecting")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByTestId("vnc-reconnect"));
        await vi.advanceTimersByTimeAsync(0);
      });
      // A user-driven attempt is a new approval: it asks before connecting.
      expect(connectCalls()).toHaveLength(3);
      expect(connectCalls()[2][1]).toMatchObject({ allowUnencrypted: false });
      expect(screen.getByTestId("vnc-overlay-unencrypted")).toBeInTheDocument();
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
}

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => true);
type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => { listeners.set(name, handler); return () => listeners.delete(name); }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
const getSession = vi.fn();
vi.mock("../../lib/ipc", () => ({ getSession: (id: string) => getSession(id) }));

import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";
import { useMobileBridge, waitForAppState } from "./useMobileBridge";

const terminalTab = (id: string, title: string, sessionId?: string) => ({ id, title, type: "terminal", sessionId }) as unknown as Tab;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });

beforeEach(() => {
  invoke.mockClear(); listeners.clear(); getSession.mockReset();
  useAppStore.setState({ tabs: [], terminalRuntimeByTab: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("waitForAppState", () => {
  it("resolves on a later store change and rejects after the timeout", async () => {
    const waiting = waitForAppState(() => useAppStore.getState().tabs[0]?.id, 1000);
    useAppStore.setState({ tabs: [terminalTab("t1", "Shell")] });
    await expect(waiting).resolves.toBe("t1");
    vi.useFakeTimers();
    const never = waitForAppState(() => null, 500);
    const settled = expect(never).rejects.toThrow("open_timeout");
    vi.advanceTimersByTime(500);
    await settled;
  });
});

describe("useMobileBridge", () => {
  it("opens a new local terminal and reports its backend key", async () => {
    const openLocalTab = vi.fn(async () => {
      useAppStore.setState({ tabs: [terminalTab("tab-1", "Local Shell")] });
      return { tabId: "tab-1", status: "started" as const };
    });
    renderHook(() => useMobileBridge({ openQueuedSession: vi.fn(), openLocalTab }));
    await flush();
    listeners.get("mobile-open-session")!({ payload: { request_id: "r1", kind: "local", saved_session_id: null } });
    await flush();
    act(() => useAppStore.setState({ terminalRuntimeByTab: { "tab-1": { backendSessionId: "local-9" } } as never }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("mobile_open_session_result", { requestId: "r1", terminalId: "local-9", error: null });
  });

  it("opens a saved session through the queue and waits for the new tab", async () => {
    getSession.mockResolvedValue({ id: "saved-1", name: "Build host" });
    useAppStore.setState({ tabs: [terminalTab("old", "Build host", "saved-1")] });
    const openQueuedSession = vi.fn(() => "awaiting-vault" as const);
    renderHook(() => useMobileBridge({ openQueuedSession, openLocalTab: vi.fn() }));
    await flush();
    listeners.get("mobile-open-session")!({ payload: { request_id: "r2", kind: "saved", saved_session_id: "saved-1" } });
    await flush();
    expect(openQueuedSession).toHaveBeenCalledWith({ id: "saved-1", name: "Build host" });
    // The pre-existing tab for the same saved session is not the one being opened.
    act(() => useAppStore.setState({ terminalRuntimeByTab: { old: { backendSessionId: "ssh-old" } } as never }));
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("mobile_open_session_result", expect.anything());
    act(() => useAppStore.setState({
      tabs: [terminalTab("old", "Build host", "saved-1"), terminalTab("new", "Build host", "saved-1")],
      terminalRuntimeByTab: { old: { backendSessionId: "ssh-old" }, new: { backendSessionId: "ssh-new" } } as never,
    }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("mobile_open_session_result", { requestId: "r2", terminalId: "ssh-new", error: null });
  });

  it("reports a missing saved session instead of hanging", async () => {
    getSession.mockRejectedValue(new Error("not found"));
    renderHook(() => useMobileBridge({ openQueuedSession: vi.fn(), openLocalTab: vi.fn() }));
    await flush();
    listeners.get("mobile-open-session")!({ payload: { request_id: "r3", kind: "saved", saved_session_id: "gone" } });
    await flush();
    expect(invoke).toHaveBeenCalledWith("mobile_open_session_result", { requestId: "r3", terminalId: null, error: "saved_session_not_found" });
  });

  it("does not dispatch an unclaimed request or retain waiters after unmount", async () => {
    invoke.mockResolvedValueOnce(false);
    const openLocalTab = vi.fn();
    const { unmount } = renderHook(() => useMobileBridge({ openQueuedSession: vi.fn(), openLocalTab }));
    await flush();
    listeners.get("mobile-open-session")!({ payload: { request_id: "denied", kind: "local", saved_session_id: null } });
    await flush();
    expect(openLocalTab).not.toHaveBeenCalled();
    unmount();
    const abort = new AbortController();
    const waiting = waitForAppState(() => null, 170000, abort.signal);
    const rejected = expect(waiting).rejects.toThrow("open_cancelled");
    abort.abort();
    await rejected;
  });

  it("mirrors each terminal title once and again only when it changes", async () => {
    renderHook(() => useMobileBridge({ openQueuedSession: vi.fn(), openLocalTab: vi.fn() }));
    act(() => useAppStore.setState({ tabs: [terminalTab("t1", "prod-db")], terminalRuntimeByTab: { t1: { backendSessionId: "k1" } } as never }));
    act(() => useAppStore.setState({ tabs: [terminalTab("t1", "prod-db")] }));
    act(() => useAppStore.setState({ tabs: [terminalTab("t1", "prod-db (2)")] }));
    const titles = invoke.mock.calls.filter(call => call[0] === "mobile_terminal_title").map(call => call[1]);
    expect(titles).toEqual([{ sessionId: "k1", title: "prod-db" }, { sessionId: "k1", title: "prod-db (2)" }]);
  });
});

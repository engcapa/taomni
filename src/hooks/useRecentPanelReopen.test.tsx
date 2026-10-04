import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRecentPanelReopen } from "./useRecentPanelReopen";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { defaultShellLayout } from "../lib/shell/shellLayoutPersistence";
import { registerPanelActions } from "../lib/shell/panelActions";
import type { PanelInstance } from "../lib/shell/types";
import type { SessionConfig } from "../lib/ipc";

const entry = { kind: "sftp" as const, restoreRef: "run-entry:saved:removed", preferredPlacement: "dock" as const, lastUsedAt: 1 };
const session: SessionConfig = { id: "replacement", name: "Same title", session_type: "SSH", host: "localhost", port: 22, username: "qa", auth_method: "Agent", options_json: "{}", group_path: "", created_at: 1, updated_at: 1, last_connected_at: null, sort_order: 0 };
const panel = (id: string, tabId: string, ref: string): PanelInstance => ({ id, kind: "sftp", owner: { kind: "tab", tabId, restoreRef: ref }, generation: 1, phase: "ready", requestedOpen: false, pinned: true, placement: { kind: "dock", edge: "right" }, operation: null, error: null });
const disposers: Array<() => void> = [];
beforeEach(() => {
  useAppStore.setState({ tabs: [{ id: "welcome", title: "Home", type: "welcome", closable: false }, { id: "other", title: "Same title", type: "terminal", closable: true }], activeTabId: "welcome", recentWorkspaces: [], terminalRuntimeByTab: {} });
  useSessionStore.setState({ sessions: [session] });
  const layout = defaultShellLayout(); layout.recentPanels = [entry]; layout.restoreSources[entry.restoreRef] = { kind: "run-entry", identity: "saved:removed" };
  useShellLayoutStore.setState({ layout, panels: { other: panel("other", "other", "run-entry:saved:other") }, restoreRefByTab: { other: "run-entry:saved:other" } });
});
afterEach(() => { cleanup(); disposers.splice(0).forEach((off) => off()); });
function openers() {
  return { openWorkspace: vi.fn(), loadSession: vi.fn().mockResolvedValue(session), openSession: vi.fn(), cancelAuth: vi.fn(), openSftp: vi.fn() };
}

it("requires explicit rebinding for a deleted owner and never adopts a same-title tab", async () => {
  const deps = openers(), { result } = renderHook(() => useRecentPanelReopen(deps));
  await expect(result.current(entry, undefined, new AbortController().signal)).rejects.toMatchObject({ code: "choose-owner" });
  expect(deps.openSession).not.toHaveBeenCalled(); expect(deps.openSftp).not.toHaveBeenCalled();
  expect(useAppStore.getState().activeTabId).toBe("welcome");
  expect(useAppStore.getState().tabs).toHaveLength(2);
  expect(useShellLayoutStore.getState().panels.other.requestedOpen).toBe(false);
});

it("rebinds only after the selected connection is ready and replaces the orphan metadata", async () => {
  const deps = openers();
  deps.openSession.mockImplementation(async () => {
    useAppStore.getState().addTab({ id: "new-owner", title: "Same title", type: "terminal", closable: true, sessionId: session.id, ssh: { host: "localhost", port: 22, username: "qa", authMethod: "Agent", authData: null } });
    return { status: "ready", tabId: "new-owner", readiness: "connected", issue: null };
  });
  deps.openSftp.mockImplementation(() => useShellLayoutStore.getState().registerPanel(panel("new-panel", "new-owner", "run-entry:saved:replacement")));
  const { result } = renderHook(() => useRecentPanelReopen(deps));
  let id!: string;
  await act(async () => { id = await result.current(entry, { kind: "session", id: session.id }, new AbortController().signal); });
  expect(id).toBe("new-panel"); expect(deps.loadSession).toHaveBeenCalledWith(session.id);
  expect(useShellLayoutStore.getState().panels[id].requestedOpen).toBe(true);
  expect(useShellLayoutStore.getState().layout.recentPanels).toEqual([expect.objectContaining({ restoreRef: "run-entry:saved:replacement", kind: "sftp" })]);
  expect(useShellLayoutStore.getState().panels.other.requestedOpen).toBe(false);
});

it("locates a live detached panel by its exact identity without creating another window", async () => {
  const original = { ...panel("exact", "other", entry.restoreRef), placement: { kind: "detached" as const, windowLabel: "window-exact" } };
  useShellLayoutStore.getState().registerPanel(original);
  const focus = vi.fn(); disposers.push(registerPanelActions(original.id, { focus }));
  const deps = openers(), { result } = renderHook(() => useRecentPanelReopen(deps));
  await act(async () => { expect(await result.current(entry, undefined, new AbortController().signal)).toBe("exact"); });
  expect(focus).toHaveBeenCalledTimes(1); expect(deps.openSession).not.toHaveBeenCalled();
  expect(useAppStore.getState().tabs).toHaveLength(2);
});

it("deduplicates an auth request and abandons the binding when that request is cancelled", async () => {
  const deps = openers();
  let release!: (value: unknown) => void;
  deps.openSession.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const { result } = renderHook(() => useRecentPanelReopen(deps));
  const controller = new AbortController();
  const one = result.current(entry, { kind: "session", id: session.id }, controller.signal);
  const two = result.current(entry, { kind: "session", id: session.id }, controller.signal);
  expect(two).toBe(one);
  await act(async () => { await Promise.resolve(); });
  controller.abort();
  expect(deps.cancelAuth).toHaveBeenCalledTimes(1);
  release({ status: "cancelled", tabId: null, issue: { message: "Auth cancelled" } });
  await expect(one).rejects.toThrow("Auth cancelled");
  expect(deps.openSftp).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toHaveLength(2);
  expect(useShellLayoutStore.getState().layout.recentPanels).toEqual([entry]);
});

it("retries a failed attach on the explicitly selected live connection without opening another SSH connection", async () => {
  const deps = openers();
  deps.openSession.mockImplementation(async () => {
    useAppStore.getState().addTab({ id: "selected-owner", title: "Same title", type: "terminal", closable: true, sessionId: session.id, ssh: { host: "localhost", port: 22, username: "qa", authMethod: "Agent", authData: null } });
    return { status: "ready", tabId: "selected-owner", readiness: "connected", issue: null };
  });
  deps.openSftp.mockImplementation(() => useShellLayoutStore.getState().registerPanel({ ...panel("retry-panel", "selected-owner", "run-entry:saved:replacement"), phase: "failed", error: { code: "attach", message: "Attach unavailable", retryable: true } }));
  const { result } = renderHook(() => useRecentPanelReopen(deps));
  const selection = { kind: "session" as const, id: session.id };
  const retry = vi.fn(() => { useShellLayoutStore.getState().patchPanel("retry-panel", { phase: "ready", error: null }); });
  disposers.push(registerPanelActions("retry-panel", { retry }));
  await expect(result.current(entry, selection, new AbortController().signal)).rejects.toThrow("Attach unavailable");
  expect(retry).not.toHaveBeenCalled();
  expect(useShellLayoutStore.getState().layout.recentPanels.some((p) => p.restoreRef === entry.restoreRef)).toBe(true);
  await act(async () => { expect(await result.current(entry, selection, new AbortController().signal)).toBe("retry-panel"); });
  expect(retry).toHaveBeenCalledTimes(1); expect(deps.openSession).toHaveBeenCalledTimes(1);
  expect(deps.openSftp).toHaveBeenCalledTimes(1); expect(useAppStore.getState().tabs).toHaveLength(3);
  expect(useShellLayoutStore.getState().layout.recentPanels).toEqual([expect.objectContaining({ restoreRef: "run-entry:saved:replacement" })]);
});

it("does not reuse a disconnected tab with the exact saved-session identity", async () => {
  useAppStore.getState().setTerminalRuntime("other", { state: "disconnected" });
  useShellLayoutStore.setState({ restoreRefByTab: { other: "run-entry:saved:replacement" } });
  const deps = openers(); deps.openSession.mockResolvedValue({ status: "failed", tabId: null, issue: { message: "Connection failed" } });
  const { result } = renderHook(() => useRecentPanelReopen(deps));
  await expect(result.current(entry, { kind: "session", id: session.id }, new AbortController().signal)).rejects.toThrow("Connection failed");
  expect(deps.openSession).toHaveBeenCalledTimes(1); expect(deps.openSftp).not.toHaveBeenCalled();
});

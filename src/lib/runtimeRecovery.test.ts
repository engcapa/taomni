import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/appStore";
import { describeTabs, trackRecoveryDescription, validateBootstrap, getRecoveryBootstrap,
  markRecoveryStartup, isRecoveryStartup, boundedUtf8, type RecoveryBootstrap } from "./runtimeRecovery";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const cold: RecoveryBootstrap = {
  version: 1, instanceId: "test-main", generation: 0, revision: 0,
  recovering: false, description: null, limitation: "terminal-state-unverified",
};
const initial = useAppStore.getState();
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("runtime recovery metadata", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockResolvedValue(undefined); });
  afterEach(() => { useAppStore.setState(initial, true); markRecoveryStartup(false); window.history.replaceState({}, "", "/"); });

  it("uses UTF-8 byte budgets without splitting code points or emitting lone surrogates", () => {
    for (const title of ["中".repeat(200), "😀".repeat(200), "a".repeat(511) + "😀", "x\ud800y\udc00z", "e\u0301".repeat(300)]) {
      const bounded = boundedUtf8(title, 512);
      expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(512);
      expect(new TextDecoder().decode(new TextEncoder().encode(bounded))).toBe(bounded);
    }
    expect(boundedUtf8("中".repeat(200), 512)).toBe("中".repeat(170));
    expect(boundedUtf8("😀".repeat(200), 512)).toBe("😀".repeat(128));
    expect(boundedUtf8("x\ud800y\udc00z", 512)).toBe("x�y�z");
    expect(boundedUtf8("a".repeat(10_000_000), 512)).toHaveLength(512);
  });

  it("does not truncate identities or poison other tabs with an invalid ID", () => {
    const tabs = [
      { id: "中".repeat(100), type: "terminal" as const, title: "bad id", closable: true },
      { id: "ok", type: "terminal" as const, title: "中".repeat(200), sessionId: "x".repeat(257), closable: true },
    ];
    expect(describeTabs({ tabs, activeTabId: tabs[0].id, terminalRuntimeByTab: {} })).toEqual({
      tabs: [{ id: "ok", kind: "terminal", title: "中".repeat(170), savedSessionId: null, terminalSessionId: null }],
      activeTabId: null,
    });
  });

  it.each(["/#terminal=detached-42", "/?terminal=detached-42"])("tracks the original detached terminal after handoff expires: %s", async (route) => {
    window.history.replaceState({}, "", route);
    const stop = trackRecoveryDescription(cold);
    useAppStore.setState({ tabs: [{ id: "tab-42", type: "terminal", title: "Original shell", closable: false }], activeTabId: "tab-42",
      terminalRuntimeByTab: { "tab-42": { backendSessionId: "original-pty-42", state: "running", updatedAt: 1 } } });
    await flush();
    expect(mocks.invoke.mock.calls.at(-1)?.[1].description).toEqual({
      tabs: [{ id: "tab-42", kind: "terminal", title: "Original shell", savedSessionId: null, terminalSessionId: "original-pty-42" }],
      activeTabId: "tab-42",
    });
    stop();
  });

  it("does not invent a saved config or terminal identity for a missing detached handoff", async () => {
    window.history.replaceState({}, "", "/#terminal=window-only");
    const stop = trackRecoveryDescription(cold);
    await flush();
    expect(mocks.invoke.mock.calls[0][1].description.tabs[0]).toMatchObject({ id: "window-only", savedSessionId: null, terminalSessionId: null });
    stop();
  });

  it("coalesces pending IPC and keeps metadata work independent of output/activity volume", async () => {
    let resolve!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const title = vi.fn(() => "中".repeat(200));
    useAppStore.setState({ tabs: [{ id: "t", type: "terminal", get title() { return title(); }, closable: true }], activeTabId: "t",
      terminalRuntimeByTab: { t: { backendSessionId: "pty", state: "running", updatedAt: 0 } } });
    const stop = trackRecoveryDescription(cold);
    await flush();
    title.mockClear();
    for (let i = 1; i <= 1000; i++) useAppStore.setState({ terminalRuntimeByTab: { t: { backendSessionId: "pty", state: "running", updatedAt: i } } });
    expect(title).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    useAppStore.setState({ tabs: [], activeTabId: "" });
    useAppStore.setState({ tabs: [{ id: "new", type: "terminal", title: "new", closable: true }], activeTabId: "new" });
    resolve();
    await flush(); await flush();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[1][1].description.activeTabId).toBe("new");
    stop();
  });

  it("projects only bounded metadata, never connection credentials or startup commands", () => {
    const state = {
      tabs: [{ id: "t1", type: "terminal" as const, title: "Shell", closable: true, sessionId: "saved-1",
        ssh: { password: "secret", startupCommand: "touch /external" } }],
      activeTabId: "t1", terminalRuntimeByTab: { t1: { backendSessionId: "original", state: "running" as const, updatedAt: 0 } },
    };
    const result = describeTabs(state as unknown as Parameters<typeof describeTabs>[0]);
    expect(result).toEqual({ tabs: [{ id: "t1", kind: "terminal", title: "Shell",
      savedSessionId: "saved-1", terminalSessionId: "original" }], activeTabId: "t1" });
    expect(JSON.stringify(result)).not.toMatch(/secret|startupCommand|touch/);
  });

  it("caps count/title and does not claim an omitted selected tab was restored", () => {
    const tabs = Array.from({ length: 150 }, (_, i) => ({
      id: `t${i}`, type: "terminal" as const, title: "x".repeat(600), closable: true,
    }));
    const result = describeTabs({ tabs, activeTabId: "t149", terminalRuntimeByTab: {} });
    expect(result.tabs).toHaveLength(128);
    expect(result.tabs[0].title).toHaveLength(512);
    expect(result.activeTabId).toBeNull();
  });

  it("does not mount business pages on failed or incompatible bootstrap", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("IPC failed"));
    await expect(getRecoveryBootstrap()).rejects.toThrow("IPC failed");
    for (const value of [{ ...cold, version: 2 }, { ...cold, generation: -1 }, { ...cold, instanceId: "" },
      { ...cold, description: { tabs: [null], activeTabId: null } }]) {
      expect(() => validateBootstrap(value as RecoveryBootstrap)).toThrow("Invalid recovery handshake");
    }
    mocks.invoke.mockResolvedValueOnce(cold);
    expect(await getRecoveryBootstrap()).toEqual(cold);
  });

  it("merges consecutive mutations and ignores runtime activity without ID changes", async () => {
    const stop = trackRecoveryDescription(cold);
    useAppStore.setState({ tabs: [{ id: "t1", type: "terminal", title: "Shell", closable: true }], activeTabId: "t1" });
    useAppStore.setState({ terminalRuntimeByTab: { t1: { backendSessionId: "native-1", state: "running", updatedAt: 1 } } });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0]).toEqual(["recovery_update", {
      instanceId: "test-main", revision: 1,
      description: { activeTabId: "t1", tabs: [{
        id: "t1", kind: "terminal", title: "Shell", savedSessionId: null, terminalSessionId: "native-1",
      }] },
    }]);
    useAppStore.setState({ terminalRuntimeByTab: { t1: { backendSessionId: "native-1", state: "running", updatedAt: 2 } } });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    useAppStore.setState({ tabs: [], activeTabId: "" });
    await flush();
    expect(mocks.invoke.mock.calls[1][1]).toMatchObject({ revision: 2, description: { tabs: [], activeTabId: null } });
    stop();
  });

  it("does not overwrite a recovery description with initial Welcome state", async () => {
    const stop = trackRecoveryDescription({ ...cold, recovering: true });
    useAppStore.setState({ activeTabId: "welcome" });
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalled();
    stop();
  });

  it("cancels queued metadata work and unsubscribes on cleanup", async () => {
    const stop = trackRecoveryDescription(cold);
    stop();
    await flush();
    useAppStore.setState({ activeTabId: "different" });
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("identifies recovery startup independently of normal cold startup", () => {
    expect(isRecoveryStartup()).toBe(false);
    markRecoveryStartup(true);
    expect(isRecoveryStartup()).toBe(true);
    markRecoveryStartup(false);
    expect(isRecoveryStartup()).toBe(false);
  });
});

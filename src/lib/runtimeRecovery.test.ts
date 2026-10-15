import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/appStore";
import { describeTabs, trackRecoveryDescription, validateBootstrap, getRecoveryBootstrap,
  markRecoveryStartup, isRecoveryStartup, type RecoveryBootstrap } from "./runtimeRecovery";

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
  afterEach(() => { useAppStore.setState(initial, true); markRecoveryStartup(false); });

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

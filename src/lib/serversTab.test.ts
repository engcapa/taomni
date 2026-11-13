import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { STUB_SERVERS_TAB_LOCK_KEY, resetStubServersTabLockForTests } from "../stubs/commands/servers";
import { invoke as invokeStubCommand } from "../stubs/tauri-core";
import { useAppStore } from "../stores/appStore";
import { useServersStore } from "../stores/serversStore";
import {
  SERVERS_TAB_ID,
  hasServersRouteParam,
  hasServersTabClaimMarker,
  openServersTab,
  releaseServersTabLockSafe,
} from "./serversTab";

const stubInvoke = vi.hoisted(() => ({
  handler: null as ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) =>
    stubInvoke.handler ? stubInvoke.handler(cmd, args) : undefined,
  ),
}));

function resetState() {
  resetStubServersTabLockForTests();
  localStorage.clear();
  sessionStorage.clear();
  useAppStore.setState({
    tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
    activeTabId: "welcome",
    statusMessage: "Ready",
  });
  useServersStore.getState().setTabBlockedMessage(null);
}

describe("serversTab singleton coordination", () => {
  beforeEach(() => {
    stubInvoke.handler = (cmd, args) => invokeStubCommand(cmd, args);
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
      invokeStubCommand(cmd, args as Record<string, unknown> | undefined),
    );
    resetState();
  });

  afterEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it("detects ?servers= and #servers= launch parameters", () => {
    expect(hasServersRouteParam("?servers=main", "")).toBe(true);
    expect(hasServersRouteParam("?tab=welcome&servers=1", "")).toBe(true);
    expect(hasServersRouteParam("", "#servers=main")).toBe(true);
    expect(hasServersRouteParam("", "#a=1&servers=main")).toBe(true);
    expect(hasServersRouteParam("?rdp=1", "#welcome")).toBe(false);
    expect(hasServersRouteParam("", "")).toBe(false);
  });

  it("opens one servers tab, deduplicates concurrent calls, and focuses on repeat triggers", async () => {
    const [first, second] = await Promise.all([openServersTab(), openServersTab()]);
    expect(first).toBe(true);
    expect(second).toBe(true);

    const tabs = useAppStore.getState().tabs.filter((tab) => tab.type === "servers");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe(SERVERS_TAB_ID);
    expect(useAppStore.getState().activeTabId).toBe(SERVERS_TAB_ID);
    expect(hasServersTabClaimMarker()).toBe(true);

    useAppStore.getState().setActiveTab("welcome");
    expect(await openServersTab()).toBe(true);
    expect(useAppStore.getState().activeTabId).toBe(SERVERS_TAB_ID);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(1);
  });

  it("blocks opening when another browser instance holds the cross-tab lease", async () => {
    localStorage.setItem(
      STUB_SERVERS_TAB_LOCK_KEY,
      JSON.stringify({ ownerId: "other-browser-tab", updatedAt: Date.now() }),
    );

    const opened = await openServersTab();
    expect(opened).toBe(false);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(0);
    expect(useAppStore.getState().activeTabId).toBe("welcome");
    expect(useServersStore.getState().tabBlockedMessage).toBeTruthy();
    expect(hasServersTabClaimMarker()).toBe(false);
  });

  it("reclaims an expired lease and releases cleanly for subsequent instances", async () => {
    localStorage.setItem(
      STUB_SERVERS_TAB_LOCK_KEY,
      JSON.stringify({ ownerId: "stale-browser-tab", updatedAt: Date.now() - 60_000 }),
    );

    expect(await openServersTab()).toBe(true);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(1);

    await releaseServersTabLockSafe();
    expect(localStorage.getItem(STUB_SERVERS_TAB_LOCK_KEY)).toBeNull();
    expect(hasServersTabClaimMarker()).toBe(false);
  });

  it("surfaces backend lock holder details when native claim_servers_tab refuses", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "claim_servers_tab") {
        return { acquired: false, holder: "Taomni (PID 4242)" };
      }
      return undefined;
    });

    const opened = await openServersTab();
    expect(opened).toBe(false);
    expect(useServersStore.getState().tabBlockedMessage).toContain("Taomni (PID 4242)");
    expect(useAppStore.getState().statusMessage).toContain("Taomni (PID 4242)");
  });

  it("prevents duplicate servers tabs in appStore addTab and duplicateTab", async () => {
    expect(await openServersTab()).toBe(true);
    useAppStore.getState().addTab({
      id: "servers-second",
      type: "servers",
      title: "Second",
      closable: true,
    });
    const tabsAfterAdd = useAppStore.getState().tabs.filter((tab) => tab.type === "servers");
    expect(tabsAfterAdd).toHaveLength(1);
    expect(tabsAfterAdd[0]?.id).toBe(SERVERS_TAB_ID);

    useAppStore.getState().duplicateTab(SERVERS_TAB_ID);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(1);
  });

  it("fails closed when backend claim_servers_tab rejects and allows reopening after release", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("lock directory unavailable"));

    const opened = await openServersTab();
    expect(opened).toBe(false);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(0);
    expect(useServersStore.getState().tabBlockedMessage).toContain("lock directory unavailable");
    expect(hasServersTabClaimMarker()).toBe(false);

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
      invokeStubCommand(cmd, args as Record<string, unknown> | undefined),
    );
    expect(await openServersTab()).toBe(true);
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "servers")).toHaveLength(1);
    await releaseServersTabLockSafe();
    expect(localStorage.getItem(STUB_SERVERS_TAB_LOCK_KEY)).toBeNull();
  });
});

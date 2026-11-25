import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";
import { useAppStore } from "../stores/appStore";
import { consumeDetachedHandoff } from "./detachedSession";
import { deferred } from "./tests/pluginFrontendHarness";
import { detachPluginTab } from "./pluginTabWindow";

const mocks = vi.hoisted(() => ({ native: vi.fn(), open: vi.fn() }));
vi.mock("./runtime", () => ({ isTauriRuntime: mocks.native }));
vi.mock("./detachWindowing", () => ({ openDetachedWindow: mocks.open }));

const tab: Tab = { id: "plugin-window-one", type: "plugin", title: "Hello", closable: true,
  plugin: { slug: "hello-plugin", kind: "hello-plugin" } };

beforeEach(() => {
  localStorage.clear();
  mocks.native.mockReset().mockReturnValue(true);
  mocks.open.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ tabs: [tab], activeTabId: tab.id });
});
afterEach(() => vi.restoreAllMocks());

describe("module window handoff ownership", () => {
  it("removes the source only after native creation succeeds and deduplicates concurrent requests", async () => {
    const opened = deferred<void>();
    mocks.open.mockReturnValueOnce(opened.promise);
    const pending = detachPluginTab({ ...tab, password: "discard-me" } as Tab);
    await detachPluginTab(tab);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ kind: "plugin", sessionId: tab.id, title: tab.title });
    expect(consumeDetachedHandoff("plugin", tab.id)).toEqual(tab);
    expect(localStorage.getItem(`taomni.detached.plugin.${tab.id}`)).not.toContain("discard-me");
    expect(useAppStore.getState().tabs).toEqual([tab]);
    opened.resolve();
    await pending;
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it("retains the source and clears handoff after native creation fails, then permits retry", async () => {
    mocks.open.mockRejectedValueOnce(new Error("window creation failed"));
    await expect(detachPluginTab(tab)).rejects.toThrow("window creation failed");
    expect(useAppStore.getState().tabs).toEqual([tab]);
    expect(consumeDetachedHandoff("plugin", tab.id)).toBeNull();
    await detachPluginTab(tab);
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it("keeps the source when a popup is blocked and uses only a locator in a successful popup", async () => {
    mocks.native.mockReturnValue(false);
    const popup = vi.spyOn(window, "open").mockReturnValueOnce(null).mockReturnValueOnce({} as Window);
    await expect(detachPluginTab(tab)).rejects.toThrow("blocked");
    expect(useAppStore.getState().tabs).toEqual([tab]);
    expect(consumeDetachedHandoff("plugin", tab.id)).toBeNull();
    await detachPluginTab(tab);
    const url = new URL(popup.mock.calls[1][0] as string);
    expect(url.searchParams.get("plugin")).toBe(tab.id);
    expect(consumeDetachedHandoff("plugin", tab.id)).toEqual(tab);
    expect(useAppStore.getState().tabs).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("does not open a window when browser storage cannot preserve the handoff", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await expect(detachPluginTab(tab)).rejects.toThrow("handoff could not be saved");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useAppStore.getState().tabs).toEqual([tab]);
  });
});

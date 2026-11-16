import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import { usePluginFrontendStore } from "../stores/pluginFrontendStore";
import { attachPluginTabPersistence } from "./pluginTabPersistence";
import { openPluginTab, readPluginTab } from "./pluginTabs";
import { moduleRecord } from "./tests/pluginFrontendHarness";

const info = { slug: "hello-plugin", kind: "hello-plugin" };
beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
  const record = moduleRecord();
  usePluginFrontendStore.setState({ records: { [record.slug]: record }, epochs: {}, pending: new Set(), status: "ready", error: null });
});

describe("module tab locators and ordinary reload", () => {
  it("opens a declared module tab, focuses its existing instance and preserves built-in tabs", () => {
    const id = openPluginTab(info);
    expect(openPluginTab(info)).toBe(id);
    expect(useAppStore.getState().tabs).toHaveLength(2);
    expect(useAppStore.getState().activeTabId).toBe(id);
    expect(useAppStore.getState().tabs[0].type).toBe("welcome");
    expect(() => openPluginTab({ ...info, kind: "undeclared" })).toThrow("unavailable");
    usePluginFrontendStore.setState({ pending: new Set([info.slug]) });
    expect(() => openPluginTab(info)).toThrow("unavailable");
  });

  it("persists only non-sensitive locators and retains an unavailable tab after reload", () => {
    const stop = attachPluginTabPersistence();
    const id = openPluginTab(info);
    stop();
    const raw = JSON.parse(localStorage.getItem("taomni.plugin-tabs.v1")!);
    expect(raw.tabs[0]).toEqual({ id, type: "plugin", title: "Hello Plugin", closable: true, plugin: info });
    useAppStore.setState({ tabs: [], activeTabId: "", activeSideTab: "home" });
    usePluginFrontendStore.setState({ records: {} });
    const stopAgain = attachPluginTabPersistence();
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().tabs[0].plugin).toEqual(info);
    expect(useAppStore.getState().activeTabId).toBe(id);
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
    stopAgain();
  });

  it("keeps an inactive locator without stealing Home after reload", () => {
    const stop = attachPluginTabPersistence();
    const id = openPluginTab(info);
    useAppStore.getState().setActiveSideTab("home");
    stop();
    const saved = JSON.parse(localStorage.getItem("taomni.plugin-tabs.v1")!);
    expect(saved.activeTabId).toBeNull();
    useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
    const stopAgain = attachPluginTabPersistence();
    expect(useAppStore.getState().tabs.some((tab) => tab.id === id)).toBe(true);
    expect(useAppStore.getState()).toMatchObject({ activeTabId: "welcome", activeSideTab: "home" });
    stopAgain();
  });

  it("cannot restore executable metadata, credentials, duplicate IDs or built-in tab injection", () => {
    const entry = { id: "plugin-one", type: "plugin", title: "Hello", closable: true, plugin: { ...info, manifest: { entry: "evil" } }, password: "secret" };
    localStorage.setItem("taomni.plugin-tabs.v1", JSON.stringify({ version: 1, tabs: [entry, entry, { ...entry, id: "settings", type: "settings" }] }));
    const stop = attachPluginTabPersistence();
    const saved = useAppStore.getState().tabs.filter((tab) => tab.type === "plugin");
    expect(saved).toEqual([{ id: "plugin-one", type: "plugin", title: "Hello", closable: true, plugin: info }]);
    expect(readPluginTab({ ...entry, plugin: { slug: "../escape", kind: "hello" } })).toBeNull();
    stop();
  });
});

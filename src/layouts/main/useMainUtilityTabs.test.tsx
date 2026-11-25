import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { useMainUtilityTabs, type UseMainUtilityTabsContext } from "./useMainUtilityTabs";

vi.mock("./useControlTools", () => ({ useControlTools: vi.fn() }));
beforeEach(() => useAppStore.setState({ tabs: [], activeTabId: null }));
afterEach(cleanup);

it("opens one Settings tab for the module section event and immediate utility request before React renders", () => {
  const state = useAppStore.getState();
  const context = {
    layout: { tabs: [], sessions: [], tabsRef: { current: [] }, addTab: state.addTab, setActiveTab: state.setActiveTab, t: () => "Settings" },
    workspaceOpening: {}, connections: {}, terminals: {}, sessionActions: {},
  } as unknown as UseMainUtilityTabsContext;
  const hook = renderHook(() => useMainUtilityTabs(context));
  act(() => {
    openSettingsSection("module-store");
    hook.result.current.openSettingsTab();
  });
  expect(useAppStore.getState().tabs.filter((tab) => tab.type === "settings")).toHaveLength(1);
  expect(useAppStore.getState().activeTabId).toBe("settings");
});

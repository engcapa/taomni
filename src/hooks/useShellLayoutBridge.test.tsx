import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useShellLayoutBridge } from "./useShellLayoutBridge";
import { useAppStore } from "../stores/appStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { defaultShellLayout } from "../lib/shell/shellLayoutPersistence";
import { beginRestoreFocus } from "../lib/shell/restoreFocus";

afterEach(cleanup);
it("reactivates a retained tab from an empty category without changing its id or bypassing restore focus", () => {
  useAppStore.setState({ tabs: [{ id: "mfa", type: "mfa", title: "MFA", closable: true }], activeTabId: "mfa" });
  useShellLayoutStore.setState({ layout: defaultShellLayout(), initialized: true, laneSelection: null });
  renderHook(useShellLayoutBridge);
  act(() => useShellLayoutStore.getState().selectLane("build"));
  expect(useShellLayoutStore.getState().laneSelection).toBe("build");
  const release = beginRestoreFocus();
  act(() => useAppStore.getState().setActiveTab("mfa"));
  expect(useShellLayoutStore.getState().laneSelection).toBe("build");
  release();
  act(() => useAppStore.getState().setActiveTab("mfa"));
  expect(useShellLayoutStore.getState().laneSelection).toBeNull();
  expect(useAppStore.getState().tabs).toHaveLength(1);
  expect(useAppStore.getState().activeTabId).toBe("mfa");
});

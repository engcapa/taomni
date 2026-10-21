import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";

const workspaceInstanceId = "routing-contract";

function useRouting() {
  const ui = useCodeWorkspaceStore((state) => selectCodeWorkspaceUi(state, workspaceInstanceId));
  return useWorkspaceToolWindowRouting({
    workspaceInstanceId,
    patchWorkspaceUi: useCodeWorkspaceStore.getState().patchInstance,
    languagePanelOpen: ui.languagePanelOpen,
    bottomDockOpen: ui.bottomDockOpen,
    bottomDockTab: ui.bottomDockTab,
    rightPaneOpenStored: ui.rightPaneOpen,
    rightPaneTab: ui.rightPaneTab,
  });
}

beforeEach(() => {
  localStorage.clear();
  useCodeWorkspaceStore.getState().ensureInstance(workspaceInstanceId);
});

afterEach(() => {
  cleanup();
  useCodeWorkspaceStore.getState().disposeInstance(workspaceInstanceId);
});

describe("workspace tool window routing", () => {
  it.each(["open-first", "tab-first"])("routes %s requests to a moved tool without opening the old dock", async (order) => {
    const { result } = renderHook(useRouting);
    act(() => result.current.toolWindowLayout.move("problems", "right-top"));
    act(() => result.current.toolWindowLayout.hide("problems"));
    const node = result.current.toolWindowNodes.node("problems", "Problems");

    await act(async () => {
      if (order === "open-first") result.current.setBottomDockOpen(true);
      result.current.setBottomDockTab("problems");
      if (order === "tab-first") result.current.setBottomDockOpen(true);
    });

    expect(result.current.toolWindowLayout.isVisible("problems")).toBe(true);
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).bottomDockOpen).toBe(false);
    expect(result.current.toolWindowNodes.node("problems", "Problems")).toBe(node);

    // The suppression belongs to one request turn, so a later ordinary dock
    // command must still work while the moved tool retains its content node.
    await act(async () => {
      result.current.setBottomDockTab("search");
      result.current.setBottomDockOpen(true);
    });
    expect(result.current.toolWindowLayout.isVisible("search")).toBe(true);
    expect(result.current.toolWindowNodes.node("problems", "Problems")).toBe(node);
  });

  it("keeps legacy documentation actions on the selected tool after hide and reopen", () => {
    const { result } = renderHook(useRouting);
    act(() => {
      result.current.setRightPaneTab("documentation");
      result.current.setRightPaneOpen(true);
    });
    expect(result.current.toolWindowLayout.isVisible("documentation")).toBe(true);
    act(() => result.current.setRightPaneOpen((open) => !open));
    expect(result.current.toolWindowLayout.isVisible("documentation")).toBe(false);
    act(() => result.current.setRightPaneOpen((open) => !open));
    expect(result.current.toolWindowLayout.isVisible("documentation")).toBe(true);
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).rightPaneTab).toBe("documentation");
  });
});

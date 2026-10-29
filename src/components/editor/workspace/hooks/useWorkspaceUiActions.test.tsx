import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";

beforeEach(() => {
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useCodeWorkspaceStore.getState().ensureInstance("selection");
});
afterEach(cleanup);

it("publishes one tree selection for repeated clicks on the same entry, retaining distinct targets", () => {
  const store = useCodeWorkspaceStore.getState();
  const { result } = renderHook(() => useWorkspaceUiActions({
    workspaceInstanceId: "selection", searchEverywhereTriggerRef: { current: null },
    patchWorkspaceUi: store.patchInstance, setStoreOpenOrder: store.setOpenOrder,
    setStoreActiveKey: store.setActiveKey, updateStoreEditorGroup: store.updateEditorGroup,
    setStoreActiveEditorGroup: store.setActiveEditorGroup,
    updateStoreExpandedRootIds: store.updateExpandedRootIds, updateStoreExpandedDirKeys: store.updateExpandedDirKeys,
  }));
  const notified = vi.fn();
  const unsubscribe = useCodeWorkspaceStore.subscribe(notified);
  for (let click = 0; click < 3; click++) {
    act(() => result.current.setSelected({ kind: "file", ref: { kind: "root", rootId: "root", path: "a.html" } }));
  }
  expect(notified).toHaveBeenCalledTimes(1);
  act(() => result.current.setSelected({ kind: "file", ref: { kind: "root", rootId: "other", path: "a.html" } }));
  act(() => result.current.setSelected({ kind: "file", ref: { kind: "loose", id: "loose", path: "a.html" } }));
  act(() => result.current.setSelected({ kind: "dir", rootId: "other", path: "a.html" }));
  act(() => result.current.setSelected({ kind: "root", rootId: "other" }));
  act(() => result.current.setSelected({ kind: "root", rootId: "other" }));
  act(() => result.current.setSelected(null));
  act(() => result.current.setSelected(null));
  expect(notified).toHaveBeenCalledTimes(6);
  expect(store.getInstance("selection").treeSelection).toBeNull();
  unsubscribe();
});

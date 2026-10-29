import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resetWorkspaceClipboardStores } from "../workspaceClipboardSession";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { useWorkspaceClipboard } from "./useWorkspaceClipboard";

afterEach(() => { cleanup(); resetWorkspaceClipboardStores(); });

it("observes clipboard leases and payloads without rerendering the workspace owner", async () => {
  const bridge = new WorkspaceObservationBridge("clipboard-owner", false);
  const observe = vi.spyOn(bridge, "observeClipboardSession");
  const publishWorkspaceObservation = vi.fn((update: (value: WorkspaceObservationBridge) => void) => update(bridge));
  const renders = vi.fn();
  const { result, unmount } = renderHook(() => {
    renders();
    return useWorkspaceClipboard({ workspaceInstanceId: "clipboard-owner", publishWorkspaceObservation });
  });
  await act(async () => {});
  renders.mockClear();
  const handle = result.current.clipboardHandle;
  let lease!: ReturnType<typeof handle.attachConsumer>;
  act(() => { lease = handle.attachConsumer("editor-a"); });
  expect(observe).toHaveBeenLastCalledWith(0, 1);
  expect(renders).not.toHaveBeenCalled();
  act(() => { handle.write({ plainText: "public text", sourceViewId: "editor-a", rectangular: false, sourceEol: "lf" }); });
  expect(observe).toHaveBeenLastCalledWith(1, 1);
  act(() => { lease.detach(); });
  expect(observe).toHaveBeenLastCalledWith(1, 0);
  expect(renders).not.toHaveBeenCalled();
  unmount();
  observe.mockClear();
  handle.setPermission("denied");
  expect(observe).not.toHaveBeenCalled();
});

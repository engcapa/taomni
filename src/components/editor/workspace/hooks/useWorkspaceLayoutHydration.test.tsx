import { act, renderHook } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceLayoutHydration } from "./useWorkspaceLayoutHydration";
import { useWorkspaceLayoutSaveScheduler } from "./useWorkspaceLayoutSaveScheduler";
import { createWorkspaceViewStateChanges } from "../workspaceViewStateChanges";

afterEach(() => vi.useRealTimers());

describe("workspace view snapshot publication", () => {
  it("does not recompose the editor owner when a caret snapshot changes", () => {
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useWorkspaceLayoutHydration({
        workspaceInstanceId: "view-publication-owner",
        workspace: { repoRoot: "", roots: [], looseFiles: [] },
        setStatusMessage: vi.fn(),
        lastProjectPanelSizeRef: { current: 240 },
        setTabPolicy: vi.fn(),
        patchWorkspaceUi: vi.fn(),
        seedTreeExpandIfEmpty: vi.fn(),
      });
    });
    renders.mockClear();
    act(() => result.current.viewStateChanges.notify());
    expect(renders).not.toHaveBeenCalled();
  });

  it("coalesces snapshots with layout changes and uses the latest writer", () => {
    vi.useFakeTimers();
    const changes = createWorkspaceViewStateChanges();
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender, unmount } = renderHook(({ writer, instance }) => {
      const persist = useRef(writer);
      persist.current = writer;
      return useWorkspaceLayoutSaveScheduler(instance, persist, changes);
    }, { initialProps: { writer: first, instance: "one" }, wrapper: StrictMode });
    act(() => result.current.schedule());
    act(() => vi.advanceTimersByTime(200));
    act(() => changes.notify());
    rerender({ writer: latest, instance: "one" });
    act(() => vi.advanceTimersByTime(249));
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(latest).toHaveBeenCalledExactlyOnceWith("one");

    act(() => changes.notify());
    rerender({ writer: latest, instance: "two" });
    act(() => vi.advanceTimersByTime(250));
    expect(latest).toHaveBeenCalledTimes(1);
    act(() => changes.notify());
    act(() => vi.advanceTimersByTime(250));
    expect(latest).toHaveBeenLastCalledWith("two");
    act(() => changes.notify());
    unmount();
    changes.notify();
    act(() => vi.advanceTimersByTime(500));
    expect(latest).toHaveBeenCalledTimes(2);
  });
});

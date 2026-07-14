import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitLineChange } from "./gitEditorChrome";
import { useDeferredGitLineChanges } from "./useDeferredGitLineChanges";

const changed: GitLineChange[] = [{
  kind: "modified",
  startLine: 0,
  endLine: 0,
  oldStartLine: 0,
  oldEndLine: 0,
  oldText: "before",
  newText: "after",
}];

describe("useDeferredGitLineChanges", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces text changes and only computes the latest visible buffer after idle", () => {
    vi.useFakeTimers();
    const buildChanges = vi.fn(() => changed);
    const initial = [{
      key: "main.rs",
      sourceKey: "head-1",
      headText: "before",
      bufferText: "first",
    }];
    const { result, rerender } = renderHook(
      ({ sources }) => useDeferredGitLineChanges(sources, { delayMs: 100, buildChanges }),
      { initialProps: { sources: initial } },
    );

    rerender({ sources: [{ ...initial[0], bufferText: "second" }] });
    rerender({ sources: [{ ...initial[0], bufferText: "final" }] });
    act(() => vi.advanceTimersByTime(99));
    expect(buildChanges).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    act(() => vi.runOnlyPendingTimers());
    expect(buildChanges).toHaveBeenCalledTimes(1);
    expect(buildChanges).toHaveBeenCalledWith("before", "final");
    expect(result.current["main.rs"]).toEqual(changed);
  });

  it("reuses a cached diff when the active buffer has not changed", () => {
    vi.useFakeTimers();
    const buildChanges = vi.fn(() => changed);
    const source = {
      key: "main.rs",
      sourceKey: "head-1",
      headText: "before",
      bufferText: "after",
    };
    const { rerender } = renderHook(
      ({ sources }) => useDeferredGitLineChanges(sources, { delayMs: 10, buildChanges }),
      { initialProps: { sources: [source] } },
    );

    act(() => vi.runAllTimers());
    rerender({ sources: [{ ...source }] });
    act(() => vi.runAllTimers());
    expect(buildChanges).toHaveBeenCalledTimes(1);
  });
});

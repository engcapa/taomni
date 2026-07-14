import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredOpenFileTodos } from "./useDeferredOpenFileTodos";

describe("useDeferredOpenFileTodos", () => {
  afterEach(() => vi.useRealTimers());

  it("defers repeated buffer scans until editing has been idle", () => {
    vi.useFakeTimers();
    const initial = {
      first: {
        key: "first",
        path: "first.rs",
        text: "// TODO: initial",
      },
    };
    const { result, rerender } = renderHook(
      ({ files }) => useDeferredOpenFileTodos(files, 100),
      { initialProps: { files: initial } },
    );

    expect(result.current[0]?.text).toBe("initial");
    rerender({ files: {
      first: { ...initial.first, text: "// TODO: first change" },
    } });
    rerender({ files: {
      first: { ...initial.first, text: "// TODO: final change" },
    } });

    act(() => vi.advanceTimersByTime(99));
    expect(result.current[0]?.text).toBe("initial");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]?.text).toBe("final change");
  });
});

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlEditorPanel, type SqlEditorHandle } from "./SqlEditorPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SqlEditorPanel document updates", () => {
  it("coalesces document serialization and flushes the latest value", () => {
    vi.useFakeTimers();
    const onDocChange = vi.fn();
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="select 1"
        handleRef={(next) => {
          handle = next;
        }}
        onDocChange={onDocChange}
      />,
    );

    expect(handle).not.toBeNull();
    act(() => {
      handle?.setValue("select 2");
      handle?.setValue("select 22");
      vi.advanceTimersByTime(199);
    });
    expect(onDocChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onDocChange).toHaveBeenCalledTimes(1);
    expect(onDocChange).toHaveBeenLastCalledWith("select 22");

    act(() => handle?.setValue("select 3"));
    act(() => view.unmount());
    expect(onDocChange).toHaveBeenCalledTimes(2);
    expect(onDocChange).toHaveBeenLastCalledWith("select 3");
  });
});

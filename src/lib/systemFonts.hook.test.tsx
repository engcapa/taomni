import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn<() => Promise<string[]>>(),
}));

vi.mock("./ipc", () => ({
  listSystemFonts: ipcMocks.listSystemFonts,
}));

import { resetSystemFontCacheForTests, useSystemFonts } from "./systemFonts";

describe("useSystemFonts", () => {
  beforeEach(() => {
    resetSystemFontCacheForTests();
    ipcMocks.listSystemFonts.mockReset();
  });

  it("shares an in-flight request and reuses the resolved font state", async () => {
    let resolveFonts: ((fonts: string[]) => void) | undefined;
    ipcMocks.listSystemFonts.mockReturnValueOnce(new Promise((resolve) => {
      resolveFonts = resolve;
    }));

    const first = renderHook(() => useSystemFonts());
    const second = renderHook(() => useSystemFonts());

    expect(first.result.current.loading).toBe(true);
    expect(second.result.current.loading).toBe(true);
    expect(ipcMocks.listSystemFonts).toHaveBeenCalledTimes(1);

    resolveFonts?.(["Zed Mono", "Alpha Mono", "alpha mono"]);

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(second.result.current.loading).toBe(false);
    });
    expect(first.result.current.fonts).toEqual(["alpha mono", "Zed Mono"]);
    expect(second.result.current).toBe(first.result.current);

    const third = renderHook(() => useSystemFonts());
    expect(third.result.current).toBe(first.result.current);
    expect(ipcMocks.listSystemFonts).toHaveBeenCalledTimes(1);
  });

  it("defers the request until the hook is enabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSystemFonts(enabled),
      { initialProps: { enabled: false } },
    );

    expect(result.current.loading).toBe(true);
    expect(ipcMocks.listSystemFonts).not.toHaveBeenCalled();

    ipcMocks.listSystemFonts.mockResolvedValueOnce(["Deferred Mono"]);
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fonts).toEqual(["Deferred Mono"]);
    expect(ipcMocks.listSystemFonts).toHaveBeenCalledTimes(1);
  });
});

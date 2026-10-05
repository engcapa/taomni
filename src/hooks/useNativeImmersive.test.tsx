import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ enabled: true, platform: "macos", decorate: vi.fn() }));
vi.mock("../lib/runtime", () => ({ isTauriRuntime: () => native.enabled, getAppPlatform: () => native.platform }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setDecorations: native.decorate }) }));
import { useNativeImmersive } from "./useNativeImmersive";
beforeEach(() => { native.enabled = true; native.platform = "macos"; native.decorate.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

it("restores native decorations after an in-flight immersive request", async () => {
  let finish!: () => void;
  native.decorate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { rerender } = renderHook(({ immersive }) => useNativeImmersive(immersive), { initialProps: { immersive: true } });
  await waitFor(() => expect(native.decorate).toHaveBeenCalledWith(false));
  rerender({ immersive: false });
  await act(async () => finish());
  await waitFor(() => expect(native.decorate).toHaveBeenLastCalledWith(true));
});

it("surfaces a native failure and clears it after recovery", async () => {
  native.decorate.mockRejectedValueOnce(new Error("Window unavailable"));
  const { result, rerender } = renderHook(({ immersive }) => useNativeImmersive(immersive), { initialProps: { immersive: true } });
  await waitFor(() => expect(result.current).toContain("Window unavailable"));
  rerender({ immersive: false });
  await waitFor(() => expect(result.current).toBeNull());
});

it("does not invoke native window operations in browser mode", async () => {
  native.enabled = false;
  renderHook(() => useNativeImmersive(true));
  await act(async () => {});
  expect(native.decorate).not.toHaveBeenCalled();
});

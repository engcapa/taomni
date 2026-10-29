import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceDiscoveryScope } from "./useWorkspaceDiscoveryScope";

const mocks = vi.hoisted(() => ({ getHomeDir: vi.fn() }));
vi.mock("../../../../lib/ipc", () => mocks);
afterEach(() => { cleanup(); mocks.getHomeDir.mockReset(); });

it("keeps HOME shallow when sources open and promotes ordinary project roots", async () => {
  mocks.getHomeDir.mockResolvedValue("/home/public");
  const { result, rerender } = renderHook(({ root, source }) => useWorkspaceDiscoveryScope(root, source), {
    initialProps: { root: "/home/public", source: false },
  });
  await act(async () => {});
  expect(result.current).toBe("root");
  rerender({ root: "/home/public", source: true });
  expect(result.current).toBe("root");
  rerender({ root: "/home/public/project", source: true });
  await waitFor(() => expect(result.current).toBe("recursive"));
});

it("never starts recursive discovery while the HOME identity is still pending", async () => {
  let resolve!: (path: string) => void;
  mocks.getHomeDir.mockReturnValue(new Promise((reply) => { resolve = reply; }));
  const { result } = renderHook(() => useWorkspaceDiscoveryScope("/home/public", true));
  expect(result.current).toBe("root");
  await act(async () => { resolve("/home/public"); });
  expect(result.current).toBe("root");
});

it("preserves ordinary project discovery if the optional HOME lookup fails", async () => {
  mocks.getHomeDir.mockRejectedValue(new Error("unavailable"));
  const { result } = renderHook(() => useWorkspaceDiscoveryScope("/project", true));
  await waitFor(() => expect(result.current).toBe("recursive"));
});

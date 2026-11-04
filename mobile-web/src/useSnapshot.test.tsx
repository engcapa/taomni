import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { request } from "./api";
import { useSnapshot } from "./useSnapshot";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), request: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const instance = { id: "pc", deviceId: "d", token: "t", endpoint: "https://pc.example", label: "PC" };

it("neither labels another path's data as current nor accepts a late aborted refresh", async () => {
  const pending: { resolve: (value: string) => void; signal?: AbortSignal }[] = [];
  vi.mocked(request).mockImplementation((_i, _p, _b, signal) => new Promise(resolve => pending.push({ resolve: resolve as (value: string) => void, signal })));
  const { result, rerender, unmount } = renderHook(({ path, revision }) => useSnapshot<string>(instance, path, revision), { initialProps: { path: "/a", revision: 0 } });
  await act(async () => pending[0].resolve("A"));
  expect(result.current.value).toBe("A");
  rerender({ path: "/a", revision: 1 });
  expect(result.current.value).toBe("A");
  expect(result.current.loading).toBe(true);
  rerender({ path: "/b", revision: 1 });
  expect(pending[1].signal?.aborted).toBe(true);
  expect(result.current.value).toBeNull();
  expect(result.current.updated).toBe("");
  await act(async () => pending[1].resolve("late A"));
  expect(result.current.value).toBeNull();
  await act(async () => pending[2].resolve("B"));
  expect(result.current.value).toBe("B");
  unmount();
  expect(pending[2].signal?.aborted).toBe(true);
});

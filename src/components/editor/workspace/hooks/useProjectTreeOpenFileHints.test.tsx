import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useProjectTreeOpenFileHints } from "./useProjectTreeOpenFileHints";

it("keeps tree badge inputs stable through clean loading, content updates and dirty typing", () => {
  const { result, rerender } = renderHook(({ files }) => useProjectTreeOpenFileHints(files), {
    initialProps: { files: {} as Record<string, { dirty?: boolean; loading?: boolean; text?: string }> },
  });
  const clean = result.current;
  rerender({ files: { a: { loading: true } } });
  expect(result.current).toBe(clean);
  rerender({ files: { a: { loading: false, text: "ready" } } });
  expect(result.current).toBe(clean);
  rerender({ files: { a: { dirty: true, text: "edited" } } });
  expect(result.current.a.dirty).toBe(true);
  const dirty = result.current;
  rerender({ files: { a: { dirty: true, text: "edited again" }, b: { text: "new clean file" } } });
  expect(result.current).toBe(dirty);
  rerender({ files: { a: { dirty: false, text: "saved" } } });
  expect(result.current).toEqual({});
});

it("keeps badges attached to their file identity through rename and close", () => {
  const { result, rerender } = renderHook(({ files }) => useProjectTreeOpenFileHints(files), { initialProps: { files: { a: { dirty: true } } as Record<string, { dirty: boolean }> } });
  rerender({ files: { b: { dirty: true } } });
  expect(result.current).toEqual({ b: { dirty: true } });
  rerender({ files: {} });
  expect(result.current).toEqual({});
});

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { create } from "zustand";
import { flushSync } from "react-dom";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("records a viewport measurement without rendering the workspace owner", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useWorkspaceEditorTelemetry({ activeKey: "file", activeEditorGroupId: "primary" });
  });
  const before = renders;
  act(() => {
    result.current.setViewportRanges((ranges) => ({ ...ranges, primary: {
      start: { line: 0, character: 0 }, end: { line: 40, character: 3 },
    } }));
    vi.advanceTimersByTime(100);
  });
  expect(renders).toBe(before);
});

it("does not schedule empty semantic overlays while a new file is committing", () => {
  const useFiles = create(() => ({ key: "first" }));
  let renders = 0;
  renderHook(() => {
    renders++;
    const key = useFiles((state) => state.key);
    const telemetry = useWorkspaceEditorTelemetry({ activeKey: key, activeEditorGroupId: "primary" });
    useEffect(() => {
      telemetry.setInlayHintsByGroup((current) => current);
      telemetry.setSemanticTokensByGroup((current) => current);
      telemetry.setBreadcrumbSymbolsByGroup((current) => current);
    }, [key]);
  });
  const before = renders;
  act(() => useFiles.setState({ key: "second" }));
  expect(renders).toBe(before + 1);
});

it("keeps pending caret updates across an urgent workspace render", () => {
  const { result, rerender } = renderHook(() => useWorkspaceEditorTelemetry({ activeKey: "file", activeEditorGroupId: "primary" }));
  act(() => {
    result.current.setCursorPositions((positions) => ({ ...positions, primary: { line: 3, character: 2 } }));
    vi.advanceTimersByTime(100);
    flushSync(() => rerender());
    result.current.setCursorPositions((positions) => ({ ...positions, primary: {
      ...positions.primary, character: positions.primary.character + 4,
    } }));
    vi.advanceTimersByTime(100);
  });
  expect(result.current.cursorPositions.primary).toEqual({ line: 3, character: 6 });
});

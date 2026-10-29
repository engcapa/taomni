import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lspInlayHints, type LspDocumentHighlight, type LspInlayHintsResult } from "../../../../lib/editor/lsp";
import { useEditorSemanticDecorations, type UseEditorSemanticDecorationsContext } from "./useEditorSemanticDecorations";
import { createWorkspaceViewportRanges } from "../workspaceViewportRanges";

vi.mock("../../../../lib/editor/lsp", async (original) => ({
  ...await original<typeof import("../../../../lib/editor/lsp")>(),
  lspInlayHints: vi.fn(),
}));

beforeEach(() => { vi.useFakeTimers(); vi.mocked(lspInlayHints).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function decorationContext(): Omit<UseEditorSemanticDecorationsContext, "cursorPositions" | "setHighlightsByGroup"> {
  const file: NonNullable<UseEditorSemanticDecorationsContext["activeFile"]> = {
    key: "plain", ref: { kind: "root", rootId: "home", path: "plain.txt" },
    path: "/home/public/plain.txt", title: "plain.txt", subtitle: "plain.txt", languagePath: "plain.txt",
    text: "{}\nalpha alpha", savedText: "{}\nalpha alpha", eol: "LF", hash: "hash", mtime: 1, size: 14,
    loading: false, saving: false, dirty: false, documentRevision: 0, error: null,
  };
  return {
    activeEditorGroupId: "primary", activeFile: file, activeFileIsLarge: false,
    autoHighlightRequestGenerationRef: { current: 0 }, occurrenceActiveFileKeyRef: { current: file.key },
    occurrenceActiveGroupIdRef: { current: "primary" }, occurrenceSessionRef: { current: null },
    openFilesRef: { current: { [file.key]: file } }, lspDescriptorForFile: () => null,
    activeCapabilities: null, activeLspDocumentIsSynced: false, lspDocumentEpochRef: { current: {} },
    isCurrentLspDocumentRequest: () => true, updateLspStatusForFile: vi.fn(), occurrenceSession: null,
    setOccurrenceSession: vi.fn(), activeInlayHintsEnabled: false, setInlayHintsByGroup: vi.fn(),
    viewportRanges: createWorkspaceViewportRanges(), setSemanticTokensByGroup: vi.fn(),
  };
}

function mountHighlights() {
  const context = decorationContext();
  const renders = vi.fn();
  const rendered = renderHook(({ position }) => {
    renders();
    const [highlights, setHighlightsByGroup] = useState<Record<string, LspDocumentHighlight[]>>({ primary: [] });
    useEditorSemanticDecorations({ ...context, setHighlightsByGroup, cursorPositions: { primary: position } });
    return highlights.primary;
  }, { initialProps: { position: { line: 0, character: 0 } } });
  renders.mockClear();
  return { ...rendered, renders };
}

it("avoids a workspace render for an empty idle highlight result", () => {
  const { renders, result } = mountHighlights();
  act(() => vi.advanceTimersByTime(500));
  expect(result.current).toEqual([]);
  expect(renders).not.toHaveBeenCalled();
});

it("still publishes matching words and clears them when the caret leaves the word", () => {
  const { result, rerender } = mountHighlights();
  rerender({ position: { line: 1, character: 2 } });
  act(() => vi.advanceTimersByTime(500));
  expect(result.current).toHaveLength(2);
  expect(result.current[0].range.start).toEqual({ line: 1, character: 0 });
  rerender({ position: { line: 0, character: 0 } });
  act(() => vi.advanceTimersByTime(500));
  expect(result.current).toEqual([]);
});

it("refreshes inlay hints for the latest viewport and drops a superseded response", async () => {
  const context = decorationContext();
  const status: LspInlayHintsResult["status"] = {
    path: context.activeFile!.path, uri: "file:///plain.txt", presetId: "test", languageId: "test", displayName: "Test",
    available: true, active: true, selectedCommandId: "test", selectedCommand: "test", installHint: null, error: null,
  };
  let finishOld!: (result: LspInlayHintsResult) => void;
  vi.mocked(lspInlayHints).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  vi.mocked(lspInlayHints).mockResolvedValue({ status, hints: [] });
  context.activeInlayHintsEnabled = true;
  context.activeLspDocumentIsSynced = true;
  context.activeCapabilities = { inlayHint: true } as UseEditorSemanticDecorationsContext["activeCapabilities"];
  context.lspDescriptorForFile = () => ({ workspaceId: "workspace", filePath: status.path });
  const { unmount } = renderHook(() => useEditorSemanticDecorations({
    ...context, cursorPositions: {}, setHighlightsByGroup: vi.fn(),
  }));
  await act(async () => vi.advanceTimersByTime(650));
  expect(lspInlayHints).toHaveBeenCalledTimes(1);
  const nextRange = { start: { line: 40, character: 0 }, end: { line: 80, character: 0 } };
  act(() => context.viewportRanges.update({ primary: nextRange }));
  await act(async () => finishOld({ status, hints: [] }));
  expect(context.setInlayHintsByGroup).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(650));
  expect(lspInlayHints).toHaveBeenLastCalledWith({ workspaceId: "workspace", filePath: status.path }, nextRange);
  expect(context.setInlayHintsByGroup).toHaveBeenCalledTimes(1);
  act(() => context.viewportRanges.update({ primary: { start: { line: 80, character: 0 }, end: { line: 100, character: 0 } } }));
  unmount();
  await act(async () => vi.advanceTimersByTime(650));
  expect(lspInlayHints).toHaveBeenCalledTimes(2);
});

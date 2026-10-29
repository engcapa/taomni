import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LspDocumentHighlight } from "../../../../lib/editor/lsp";
import { useEditorSemanticDecorations, type UseEditorSemanticDecorationsContext } from "./useEditorSemanticDecorations";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mountHighlights() {
  const file: NonNullable<UseEditorSemanticDecorationsContext["activeFile"]> = {
    key: "plain", ref: { kind: "root", rootId: "home", path: "plain.txt" },
    path: "/home/public/plain.txt", title: "plain.txt", subtitle: "plain.txt", languagePath: "plain.txt",
    text: "{}\nalpha alpha", savedText: "{}\nalpha alpha", eol: "LF", hash: "hash", mtime: 1, size: 14,
    loading: false, saving: false, dirty: false, documentRevision: 0, error: null,
  };
  const context: Omit<UseEditorSemanticDecorationsContext, "cursorPositions" | "setHighlightsByGroup"> = {
    activeEditorGroupId: "primary", activeFile: file, activeFileIsLarge: false,
    autoHighlightRequestGenerationRef: { current: 0 }, occurrenceActiveFileKeyRef: { current: file.key },
    occurrenceActiveGroupIdRef: { current: "primary" }, occurrenceSessionRef: { current: null },
    openFilesRef: { current: { [file.key]: file } }, lspDescriptorForFile: () => null,
    activeCapabilities: null, activeLspDocumentIsSynced: false, lspDocumentEpochRef: { current: {} },
    isCurrentLspDocumentRequest: () => true, updateLspStatusForFile: vi.fn(), occurrenceSession: null,
    setOccurrenceSession: vi.fn(), activeInlayHintsEnabled: false, setInlayHintsByGroup: vi.fn(),
    viewportRanges: {}, setSemanticTokensByGroup: vi.fn(),
  };
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

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenFileViewModel } from "../editorGroupTypes";
import { readWorkspaceRecoveryEntries } from "../workspaceRecovery";
import { useWorkspaceRecoveryState } from "./useWorkspaceRecoveryState";

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const file: OpenFileViewModel = {
  key: "plain", ref: { kind: "root", rootId: "home", path: "plain.txt" },
  path: "/home/public/plain.txt", title: "plain.txt", subtitle: "plain.txt", languagePath: "plain.txt",
  text: "disk", savedText: "disk", eol: "LF", hash: "hash", mtime: 1, size: 4,
  loading: false, saving: false, dirty: false, documentRevision: 0, error: null,
};

function mountRecovery() {
  const renders = vi.fn();
  const openFilesRef = { current: { plain: file } };
  const setTabPolicyReceipt = vi.fn();
  const setStatusMessage = vi.fn();
  const rendered = renderHook(({ files }) => {
    renders();
    openFilesRef.current = files;
    return useWorkspaceRecoveryState({
      workspaceInstanceId: "recovery-render", openFiles: files, openFilesRef,
      setTabPolicyReceipt, setStatusMessage,
    });
  }, { initialProps: { files: { plain: file } } });
  renders.mockClear();
  return { ...rendered, renders };
}

it("reconciles clean files without publishing an unchanged empty recovery view", () => {
  const { renders, result } = mountRecovery();
  act(() => vi.advanceTimersByTime(400));
  expect(renders).not.toHaveBeenCalled();
  expect(result.current.workspaceRecoveryEntries).toEqual([]);
  expect(readWorkspaceRecoveryEntries("recovery-render")).toEqual([]);
});

it("retains the latest dirty draft on disk and removes it immediately after save", () => {
  const { result, rerender } = mountRecovery();
  rerender({ files: { plain: { ...file, text: "draft", dirty: true, documentRevision: 1 } } });
  act(() => vi.advanceTimersByTime(400));
  expect(result.current.workspaceRecoveryEntries[0].text).toBe("draft");
  expect(readWorkspaceRecoveryEntries("recovery-render")[0].text).toBe("draft");
  rerender({ files: { plain: { ...file, text: "new draft", dirty: true, documentRevision: 2 } } });
  act(() => vi.advanceTimersByTime(400));
  expect(readWorkspaceRecoveryEntries("recovery-render")[0].text).toBe("new draft");
  rerender({ files: { plain: { ...file, text: "new draft", savedText: "new draft", documentRevision: 2 } } });
  expect(result.current.workspaceRecoveryEntries).toEqual([]);
  expect(readWorkspaceRecoveryEntries("recovery-render")).toEqual([]);
});

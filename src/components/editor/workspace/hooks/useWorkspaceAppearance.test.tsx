import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CODE_VIEW_PROFILE, saveCodeViewProfile } from "../../../../lib/codeViewProfile";
import { editorAppearanceProfileStorageKey, writeEditorAppearanceProfile, defaultEditorAppearanceProfile } from "../editorAppearanceProfile";
import { acquireClipboardStore, resetWorkspaceClipboardStores } from "../workspaceClipboardSession";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); resetWorkspaceClipboardStores(); vi.restoreAllMocks(); });

function fixture() {
  return {
    workspaceInstanceId: "appearance-a", clipboardHandle: acquireClipboardStore("appearance-a"), setStatusMessage: vi.fn(),
    activeEditorGroupIdRef: { current: "primary" }, activeEditorGroupId: "primary", activeKey: null as string | null,
    openFilesRef: { current: {} },
  };
}

it("does not reread or normalize stored appearance during file activation and caret updates", () => {
  const ports = fixture();
  const { rerender } = renderHook(({ key }) => useWorkspaceAppearance({ ...ports, activeKey: key }), {
    initialProps: { key: null as string | null },
  });
  const read = vi.spyOn(Storage.prototype, "getItem");
  rerender({ key: "root:a.txt" });
  rerender({ key: "root:b.html" });
  rerender({ key: "root:a.txt" });
  expect(read.mock.calls.filter(([key]) => key === editorAppearanceProfileStorageKey("appearance-a") || key === "taomni.codeViewProfile.v1")).toEqual([]);
});

it("reloads the correct workspace appearance and continues to follow global settings", () => {
  writeEditorAppearanceProfile("appearance-a", { ...defaultEditorAppearanceProfile(), fontSizePx: 17 });
  writeEditorAppearanceProfile("appearance-b", { ...defaultEditorAppearanceProfile(), fontSizePx: 22 });
  const ports = fixture();
  const { result, rerender } = renderHook(({ id }) => useWorkspaceAppearance({ ...ports, workspaceInstanceId: id }), {
    initialProps: { id: "appearance-a" },
  });
  expect(result.current.editorAppearanceProfile.fontSizePx).toBe(17);
  rerender({ id: "appearance-b" });
  expect(result.current.editorAppearanceProfile.fontSizePx).toBe(22);
  act(() => saveCodeViewProfile({ ...DEFAULT_CODE_VIEW_PROFILE, fontFamily: "QA Mono", fontSize: 19, fontLigatures: false }));
  expect(result.current.editorAppearanceProfile).toMatchObject({ fontSizePx: 19, fontFamily: "QA Mono", ligatures: false });
  expect(JSON.parse(localStorage.getItem(editorAppearanceProfileStorageKey("appearance-b"))!)).toMatchObject({ profile: { fontSizePx: 19 } });
});

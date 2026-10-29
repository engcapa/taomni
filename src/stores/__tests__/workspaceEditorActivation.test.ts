import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceDocumentRecovery, WORKSPACE_DOCUMENT_RECOVERY_KEY } from "../workspaceDocumentRecovery";
import { useWorkspaceEditorStore } from "../workspaceEditorStore";

beforeEach(() => {
  localStorage.clear();
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null, recoveryError: null });
});
afterEach(() => vi.restoreAllMocks());

describe("workspace file activation and recovery journal", () => {
  it("does not synchronously rewrite the draft journal when clean files load or activate", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const store = useWorkspaceEditorStore.getState();
    store.setDocument("a", { path: "a.html", loading: true });
    store.setDocument("a", { text: "<p>Hello</p>", savedText: "<p>Hello</p>", loading: false });
    store.setActiveTab("a");
    store.setDocument("b", { path: "b.txt", text: "text", savedText: "text" });
    store.setActiveTab("b");
    store.removeDocument("a");
    expect(write).not.toHaveBeenCalled();
    expect(useWorkspaceEditorStore.getState().documents.b.text).toBe("text");
  });

  it("preserves the last keystroke immediately while clean-file activity leaves an existing draft alone", () => {
    const store = useWorkspaceEditorStore.getState();
    store.setDocument("draft", { path: "draft.txt", text: "changed", savedText: "saved", dirty: true });
    expect(readWorkspaceDocumentRecovery().draft.text).toBe("changed");
    const write = vi.spyOn(Storage.prototype, "setItem");
    store.setDocument("clean", { path: "other.txt", text: "other", savedText: "other" });
    store.setDocument("draft", { loading: false, error: "temporarily unavailable" });
    store.removeDocument("clean");
    expect(write).not.toHaveBeenCalled();
    store.setDocument("draft", { text: "changed!" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(readWorkspaceDocumentRecovery().draft.text).toBe("changed!");
    store.setDocument("draft", { savedText: "changed!", dirty: false });
    expect(readWorkspaceDocumentRecovery()).toEqual({});
  });

  it("removes closed drafts and preserves recovery-relevant metadata", () => {
    const store = useWorkspaceEditorStore.getState();
    store.setDocument("draft", { path: "before.txt", text: "draft", dirty: true });
    store.setDocument("draft", { path: "after.html", language: "html", savedHash: "disk-hash" });
    expect(readWorkspaceDocumentRecovery().draft).toMatchObject({ path: "after.html", language: "html", savedHash: "disk-hash" });
    store.removeDocument("draft");
    expect(readWorkspaceDocumentRecovery()).toEqual({});
  });

  it("retries a failed recovery write on the next document publication", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("storage full"); });
    const store = useWorkspaceEditorStore.getState();
    store.setDocument("draft", { path: "draft.txt", text: "retained", dirty: true });
    expect(useWorkspaceEditorStore.getState().recoveryError).toBe("storage full");
    store.setDocument("clean", { path: "clean.txt" });
    expect(write).toHaveBeenLastCalledWith(WORKSPACE_DOCUMENT_RECOVERY_KEY, expect.stringContaining("retained"));
    expect(useWorkspaceEditorStore.getState().recoveryError).toBeNull();
    expect(readWorkspaceDocumentRecovery().draft.text).toBe("retained");
  });

  it("does not notify document consumers for identical activation or buffer publications", () => {
    const store = useWorkspaceEditorStore.getState();
    store.setDocument("a", { path: "a.txt", text: "text" });
    store.setActiveTab("a");
    const notified = vi.fn();
    const unsubscribe = useWorkspaceEditorStore.subscribe(notified);
    store.setActiveTab("a");
    store.setDocument("a", { path: "a.txt", text: "text" });
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });
});

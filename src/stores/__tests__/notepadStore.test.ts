import { beforeEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "../documentStore";
import { nextUntitledName, useNotepadStore } from "../notepadStore";
import { documentPathKey, isUntitledKey } from "../../lib/openFile/pathIdentity";

beforeEach(() => {
  localStorage.clear();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
  useNotepadStore.setState({ docs: {} });
});

describe("notepad document identity & store (V-01)", () => {
  it("preserves untitled keys, creates untitled docs, increments names, and rekeys on Save As", async () => {
    expect(isUntitledKey("untitled:abc-1")).toBe(true);
    expect(documentPathKey("untitled:abc-1")).toBe("untitled:abc-1");
    expect(nextUntitledName("新建 {n}", ["新建 1", "notes.txt"])).toBe("新建 2");

    const docId = "untitled:u1";
    useDocumentStore.getState().createUntitled(docId, { content: "hello", eol: "CRLF" });
    await useDocumentStore.getState().open(docId);
    const created = useDocumentStore.getState().documents[docId];
    expect(created).toMatchObject({ content: "hello", dirty: true, eol: "CRLF", savedHash: "" });

    useNotepadStore.getState().ensureDoc(docId, "新建 1");
    useNotepadStore.getState().toggleBookmark(docId, 0);
    useNotepadStore.getState().patchDoc(docId, { split: true, orient: "h" });

    useDocumentStore.getState().rekey(docId, "/tmp/saved.txt", { hash: "h123", size: 5, mtime: 99 });
    useNotepadStore.getState().rekeyDoc(docId, "/tmp/saved.txt", "saved.txt");

    expect(useDocumentStore.getState().documents[docId]).toBeUndefined();
    expect(useDocumentStore.getState().documents["/tmp/saved.txt"]).toMatchObject({
      path: "/tmp/saved.txt",
      savedHash: "h123",
      dirty: false,
      content: "hello",
    });
    expect(useNotepadStore.getState().docs["/tmp/saved.txt"]).toMatchObject({
      split: true,
      orient: "h",
      bookmarks: [0],
      titleHint: "saved.txt",
    });
  });

  it("manages marks, panel positions, and clipboard history cap", () => {
    const docId = "/docs/sample.txt";
    const store = useNotepadStore.getState();
    store.ensureDoc(docId);
    store.addMark(docId, { id: "m1", style: 1, query: "TODO", mode: "normal", caseSensitive: true, wholeWord: false });
    expect(useNotepadStore.getState().docs[docId].marks).toHaveLength(1);
    store.clearMarks(docId, 2);
    expect(useNotepadStore.getState().docs[docId].marks).toHaveLength(1);
    store.clearMarks(docId, 1);
    expect(useNotepadStore.getState().docs[docId].marks).toHaveLength(0);

    store.setPanelPos("minimap", "float", { x: 120, y: 80 });
    expect(useNotepadStore.getState().panels.minimap).toMatchObject({ pos: "float", x: 120, y: 80 });

    for (let i = 0; i < 35; i += 1) store.pushClipboardHistory(`item-${i}`);
    expect(useNotepadStore.getState().clipboardHistory).toHaveLength(30);
    expect(useNotepadStore.getState().clipboardHistory[0]).toBe("item-34");
  });
});

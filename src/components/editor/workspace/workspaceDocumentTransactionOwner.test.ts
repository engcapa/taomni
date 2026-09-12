import { describe, expect, it } from "vitest";
import { EditorState, ChangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  WorkspaceDocumentTransactionOwner,
  LARGE_FILE_UNDO_DEPTH,
  remoteTransactionAnnotation,
  type DocumentChangeDelta,
  type DocumentTransaction,
} from "./workspaceDocumentTransactionOwner";

describe("§8.26 / ED-MULTIVIEW-002: WorkspaceDocumentTransactionOwner", () => {
  it("manages subscriptions and increments document revision monotonically", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("file-1", "", 0);
    expect(owner.getRevision("file-1")).toBe(0);

    const received: DocumentTransaction[] = [];
    const unsubscribe = owner.subscribe("file-1", (tr) => {
      received.push(tr);
    });

    const tr1 = owner.dispatchTransaction(
      "file-1",
      "primary",
      [{ from: 0, to: 0, insert: "hello" }],
      "user-input",
    );

    expect(tr1).not.toBeNull();
    expect(tr1!.revision).toBe(1);
    expect(owner.getRevision("file-1")).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].sourceViewId).toBe("primary");
    expect(received[0].changes).toEqual([{ from: 0, to: 0, insert: "hello" }]);

    unsubscribe();
    owner.dispatchTransaction(
      "file-1",
      "primary",
      [{ from: 5, to: 5, insert: " world" }],
      "user-input",
    );

    expect(owner.getRevision("file-1")).toBe(2);
    // Listener was unsubscribed, so received count unchanged
    expect(received).toHaveLength(1);
  });

  it("coordinates incremental delta between two simulated CodeMirror views with echo suppression", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const initialText = "function hello() {\n  return 42;\n}\n";
    owner.initializeDocument("main.ts", initialText);

    // Setup View 1 (Primary Split)
    const state1 = EditorState.create({ doc: initialText });
    const view1 = new EditorView({ state: state1 });

    // Setup View 2 (Secondary Split)
    const state2 = EditorState.create({ doc: initialText });
    const view2 = new EditorView({ state: state2 });

    // Wire up View 2 to receive remote transactions from owner
    owner.subscribe("main.ts", (tr) => {
      if (tr.sourceViewId === "secondary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view2.state.doc.length);
      const mappedSelection = view2.state.selection.map(changeSet);
      view2.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // Wire up View 1 to receive remote transactions from owner
    owner.subscribe("main.ts", (tr) => {
      if (tr.sourceViewId === "primary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view1.state.doc.length);
      const mappedSelection = view1.state.selection.map(changeSet);
      view1.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // View 1 types "async " before "function"
    const deltas1: DocumentChangeDelta[] = [{ from: 0, to: 0, insert: "async " }];
    view1.dispatch({ changes: deltas1 });
    owner.dispatchTransaction("main.ts", "primary", deltas1, "user-input");

    // Both views match text identically without resetting View 2's document
    expect(view1.state.doc.toString()).toBe("async function hello() {\n  return 42;\n}\n");
    expect(view2.state.doc.toString()).toBe("async function hello() {\n  return 42;\n}\n");

    // View 2 edits the return value 42 -> 100
    // "async function hello() {\n  return " length is 32
    const returnValPos = view2.state.doc.toString().indexOf("42");
    const deltas2: DocumentChangeDelta[] = [{ from: returnValPos, to: returnValPos + 2, insert: "100" }];
    view2.dispatch({ changes: deltas2 });
    owner.dispatchTransaction("main.ts", "secondary", deltas2, "user-input");

    expect(view1.state.doc.toString()).toBe("async function hello() {\n  return 100;\n}\n");
    expect(view2.state.doc.toString()).toBe("async function hello() {\n  return 100;\n}\n");

    // Total document revision incremented exactly twice
    expect(owner.getRevision("main.ts")).toBe(2);

    view1.destroy();
    view2.destroy();
  });

  it("handles multi-split multi-edit completion without corrupting sibling caret mapping", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const doc = "import java.util.List;\n\nclass App {\n  List items;\n}\n";
    owner.initializeDocument("App.java", doc);

    const view1 = new EditorView({ state: EditorState.create({ doc }) });
    const view2 = new EditorView({ state: EditorState.create({ doc }) });

    // Place caret in View 2 at end of App class
    const caretPosView2 = doc.indexOf("List items;");
    view2.dispatch({ selection: { anchor: caretPosView2 } });

    owner.subscribe("App.java", (tr) => {
      if (tr.sourceViewId === "secondary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view2.state.doc.length);
      const mappedSelection = view2.state.selection.map(changeSet);
      view2.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // Multi-edit in View 1: auto-import Map at line 0 + change items type to Map
    const autoImportDelta: DocumentChangeDelta = { from: 0, to: 0, insert: "import java.util.Map;\n" };
    const typeChangeDelta: DocumentChangeDelta = { from: doc.indexOf("List items;"), to: doc.indexOf("List items;") + 4, insert: "Map" };

    view1.dispatch({ changes: [autoImportDelta, typeChangeDelta] });
    owner.dispatchTransaction("App.java", "primary", [autoImportDelta, typeChangeDelta], "completion");

    // View 2 document matches View 1 exactly
    expect(view2.state.doc.toString()).toBe(view1.state.doc.toString());

    // View 2 caret mapped forward past the inserted import line
    const importLen = "import java.util.Map;\n".length;
    expect(view2.state.selection.main.head).toBe(caretPosView2 + importLen);

    view1.destroy();
    view2.destroy();
  });

  it("keeps one undo ledger across views and releases it only after the final lease", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("main.ts", "primary", "hello");
    expect(owner.acquireView("main.ts", "secondary", "stale")).toBe("hello");

    const transactions: DocumentTransaction[] = [];
    const unsubscribe = owner.subscribe("main.ts", (transaction) => {
      transactions.push(transaction);
    });

    const edit = owner.dispatchTransaction(
      "main.ts",
      "primary",
      [{ from: 5, to: 5, insert: " world" }],
      "user-input",
    );
    expect(edit?.changes).toEqual([{ from: 5, to: 5, insert: " world" }]);
    expect(owner.getDocument("main.ts")).toBe("hello world");
    expect(owner.getHistoryState("main.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

    const undo = owner.undo("main.ts", "secondary");
    expect(undo?.sourceViewId).toBe("secondary");
    expect(undo?.origin).toBe("undo");
    expect(owner.getDocument("main.ts")).toBe("hello");
    expect(owner.getHistoryState("main.ts")).toMatchObject({ canRedo: true, redoDepth: 1 });

    const redo = owner.redo("main.ts", "primary");
    expect(redo?.sourceViewId).toBe("primary");
    expect(owner.getDocument("main.ts")).toBe("hello world");
    expect(owner.getHistoryState("main.ts")).toMatchObject({ canUndo: true, canRedo: false });
    expect(transactions.map((transaction) => transaction.origin)).toEqual([
      "user-input",
      "undo",
      "redo",
    ]);

    expect(owner.releaseView("main.ts", "primary")).toBe(false);
    expect(owner.getDocument("main.ts")).toBe("hello world");
    expect(owner.getHistoryState("main.ts").canUndo).toBe(true);
    expect(owner.releaseView("main.ts", "secondary")).toBe(true);
    expect(owner.getDocument("main.ts")).toBeNull();
    expect(owner.getHistoryState("main.ts")).toEqual({
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0,
    });
    unsubscribe();
  });

  it("rejects a stale or malformed delta without changing document or history", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("main.ts", "hello");

    expect(owner.dispatchTransaction(
      "main.ts",
      "primary",
      [{ from: 99, to: 99, insert: "!" }],
    )).toBeNull();
    expect(owner.dispatchTransaction(
      "main.ts",
      "primary",
      [{ from: 1, to: 4, insert: "i", deleted: "wrong" }],
    )).toBeNull();
    expect(owner.getDocument("main.ts")).toBe("hello");
    expect(owner.getHistoryState("main.ts")).toMatchObject({ canUndo: false, canRedo: false });
  });

  // ED-AUDIT-008 regression: replaceDocument derives its delta with
  // singleReplacement, which declares an explicit empty `deleted` for pure
  // insertions, while applyChanges omits the field when nothing was deleted.
  // The deleted-equality guard compared "" against undefined and rejected the
  // owner's own delta, so every programmatic pure insertion (the import
  // quick fix) returned null and CodeMirrorHost swallowed the store change —
  // the visible editor never received the applied text.
  it("applies a pure insertion through replaceDocument and publishes it to splits", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("main.ts", "package app;\n\nclass Main {}\n");

    const received: DocumentTransaction[] = [];
    owner.subscribe("main.ts", (tr) => received.push(tr));

    const nextText = "package app;\n\nimport app.util.Foo;\n\nclass Main {}\n";
    const transaction = owner.replaceDocument("main.ts", "primary", nextText, "external-disk");

    expect(transaction).not.toBeNull();
    expect(owner.getDocument("main.ts")).toBe(nextText);
    expect(received).toHaveLength(1);
    expect(received[0].origin).toBe("external-disk");
    // The insertion must be replayable: one undo returns the canonical text.
    expect(owner.getHistoryState("main.ts").canUndo).toBe(true);
    const undo = owner.undo("main.ts", "primary");
    expect(undo).not.toBeNull();
    expect(owner.getDocument("main.ts")).toBe("package app;\n\nclass Main {}\n");
  });

  // ED-AUDIT-008: a workspace-history restore reconciles through origin
  // "undo" — the journal transaction owns that history unit, so the document
  // ledger must not record a second (mirror) entry that a follow-up Ctrl+Z
  // could pop to re-apply the undone change.
  it("records no document-ledger entry for an undo-origin reconciliation and stale-guards the superseded entry", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("main.ts", "package app;\n\nclass Main {}\n");

    const received: DocumentTransaction[] = [];
    owner.subscribe("main.ts", (tr) => received.push(tr));

    // The intention apply reaches the ledger as a normal external snapshot.
    const applied = "package app;\n\nimport app.util.StringUtils;\n\nclass Main {}\n";
    expect(owner.replaceDocument("main.ts", "primary", applied, "external-disk")).not.toBeNull();
    expect(owner.getHistoryState("main.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

    // The journal restore reconciles the same document back through the
    // "undo" origin: published to every view, but never recorded.
    expect(owner.replaceDocument("main.ts", "journal-restore", "package app;\n\nclass Main {}\n", "undo")).not.toBeNull();
    expect(received).toHaveLength(2);
    expect(received[1].origin).toBe("undo");
    expect(owner.getHistoryState("main.ts").undoDepth).toBe(1);

    // The superseded entry is stale: a document undo must not re-apply the
    // change the journal just undid.
    expect(owner.undo("main.ts", "primary")).toBeNull();
    expect(owner.getDocument("main.ts")).toBe("package app;\n\nclass Main {}\n");

    // Once the journal re-applies (redo) through the same channel, the
    // recorded entry becomes valid again and document undo works.
    expect(owner.replaceDocument("main.ts", "journal-restore", applied, "undo")).not.toBeNull();
    const undo = owner.undo("main.ts", "primary");
    expect(undo).not.toBeNull();
    expect(owner.getDocument("main.ts")).toBe("package app;\n\nclass Main {}\n");
    expect(owner.redo("main.ts", "primary")).not.toBeNull();
    expect(owner.getDocument("main.ts")).toBe(applied);
  });
});

describe("ED-AUDIT-005: large-file undo depth bound", () => {
  // 2 MiB initial text trips the large-file threshold; each keystroke then
  // retains full before/after texts, which grew unbounded (~GBs on 5 MiB).
  const bigText = `// pad\n${"x".repeat(2 * 1024 * 1024)}`;

  function typeChar(owner: WorkspaceDocumentTransactionOwner, key: string, ch: string) {
    const doc = owner.getDocument(key) ?? "";
    const tr = owner.dispatchTransaction(key, "primary", [{ from: doc.length, to: doc.length, insert: ch }], "user-input");
    expect(tr).not.toBeNull();
  }

  it("caps retained undo entries on large documents while undo stays correct", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("big.txt", bigText);
    for (let i = 0; i < LARGE_FILE_UNDO_DEPTH + 10; i += 1) typeChar(owner, "big.txt", "k");
    const state = owner.getHistoryState("big.txt");
    expect(state.undoDepth).toBe(LARGE_FILE_UNDO_DEPTH);
    expect(state.canUndo).toBe(true);
    // The kept tail still inverts: one undo removes exactly the last char.
    const before = owner.getDocument("big.txt") ?? "";
    expect(owner.undo("big.txt", "primary")).not.toBeNull();
    expect(owner.getDocument("big.txt")).toBe(before.slice(0, -1));
    expect(owner.getHistoryState("big.txt").undoDepth).toBe(LARGE_FILE_UNDO_DEPTH - 1);
  });

  it("leaves small-document history unbounded", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("small.txt", "hello");
    for (let i = 0; i < LARGE_FILE_UNDO_DEPTH + 10; i += 1) typeChar(owner, "small.txt", "k");
    expect(owner.getHistoryState("small.txt").undoDepth).toBe(LARGE_FILE_UNDO_DEPTH + 10);
  });

  it("caps retention above the 512 KiB cost threshold even below M6-B mode", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.initializeDocument("mid.txt", `// pad\n${"y".repeat(600 * 1024)}`);
    for (let i = 0; i < LARGE_FILE_UNDO_DEPTH + 5; i += 1) typeChar(owner, "mid.txt", "k");
    expect(owner.getHistoryState("mid.txt").undoDepth).toBe(LARGE_FILE_UNDO_DEPTH);
  });
});

// ---------------------------------------------------------------------------
// ED-IMPROVE-008: one confirmed IME composition is one logical undo, a
// cancelled composition consumes no undo, and a competing origin breaks the
// coalescing session instead of merging into it.
// ---------------------------------------------------------------------------
describe("ED-IMPROVE-008: composition history coalescing", () => {
  function insertAt(owner: WorkspaceDocumentTransactionOwner, viewId: string, at: number, text: string) {
    const record = "x".repeat(at);
    void record;
    return owner.dispatchTransaction(
      "ime.ts",
      viewId,
      [{ from: at, to: at, insert: text }],
      "composition",
    );
  }

  it("coalesces successive composition deltas into one undo entry", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "hello ");
    // Progressively composing "你好" as the IME updates the preedit.
    insertAt(owner, "primary", 6, "n");
    insertAt(owner, "primary", 7, "i");
    insertAt(owner, "primary", 8, "h");
    insertAt(owner, "primary", 9, "a");
    insertAt(owner, "primary", 10, "o");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });
    expect(owner.getDocument("ime.ts")).toBe("hello nihao");

    owner.finalizeComposition("ime.ts");
    const undone = owner.undo("ime.ts", "primary");
    expect(undone).not.toBeNull();
    expect(owner.getDocument("ime.ts")).toBe("hello ");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 0 });
  });

  it("drops a cancelled composition so it consumes no undo step", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "hello");
    owner.dispatchTransaction("ime.ts", "primary", [{ from: 5, to: 5, insert: "!" }], "user-input");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });

    // Compose then cancel: the final revert arrives as a normal transaction.
    insertAt(owner, "primary", 6, "n");
    insertAt(owner, "primary", 7, "i");
    owner.dispatchTransaction("ime.ts", "primary", [{ from: 6, to: 8, insert: "" }], "user-input");
    expect(owner.getDocument("ime.ts")).toBe("hello!");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });

    // The one remaining undo belongs to the real edit, not the cancelled IME.
    owner.undo("ime.ts", "primary");
    expect(owner.getDocument("ime.ts")).toBe("hello");
  });

  it("does not merge a new composition into an unrelated open entry", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "");
    insertAt(owner, "primary", 0, "a");
    // A different origin breaks the session.
    owner.dispatchTransaction("ime.ts", "primary", [{ from: 1, to: 1, insert: "b" }], "user-input");
    insertAt(owner, "primary", 2, "c");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 3 });
    expect(owner.getDocument("ime.ts")).toBe("abc");
  });

  it("closes composition ownership on undo/redo and external replacement", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "");
    insertAt(owner, "primary", 0, "x");
    owner.undo("ime.ts", "primary");
    expect(owner.getDocument("ime.ts")).toBe("");
    insertAt(owner, "primary", 0, "y");
    // After undo, a new composition starts a fresh entry rather than merging.
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });
    owner.replaceDocument("ime.ts", "secondary", "external", "external-disk");
    expect(owner.getDocument("ime.ts")).toBe("external");
  });

  it("isolates consecutive composition sessions by session ID into distinct undo entries (ED-REPAIR-007-A1)", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "");

    // Session 1: compose "你"
    owner.dispatchTransaction(
      "ime.ts",
      "primary",
      [{ from: 0, to: 0, insert: "你" }],
      "composition",
      "comp_session_1",
    );
    expect(owner.getDocument("ime.ts")).toBe("你");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });

    // Session 2: compose "好" without any intervening non-composition transaction
    owner.dispatchTransaction(
      "ime.ts",
      "primary",
      [{ from: 1, to: 1, insert: "好" }],
      "composition",
      "comp_session_2",
    );
    expect(owner.getDocument("ime.ts")).toBe("你好");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 2 });

    // First undo reverts "好", leaving "你"
    const undone1 = owner.undo("ime.ts", "primary");
    expect(undone1).not.toBeNull();
    expect(owner.getDocument("ime.ts")).toBe("你");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });

    // Second undo reverts "你", leaving ""
    const undone2 = owner.undo("ime.ts", "primary");
    expect(undone2).not.toBeNull();
    expect(owner.getDocument("ime.ts")).toBe("");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 0 });
  });

  it("guards against stale session finalization closing newer sessions (ED-REPAIR-007-A2)", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime.ts", "primary", "");

    // Start session 2
    owner.dispatchTransaction(
      "ime.ts",
      "primary",
      [{ from: 0, to: 0, insert: "A" }],
      "composition",
      "comp_session_2",
    );

    // Stale timer/callback attempts to finalize session 1
    owner.finalizeComposition("ime.ts", "comp_session_1");

    // Session 2 is still open and can coalesce further preedits
    owner.dispatchTransaction(
      "ime.ts",
      "primary",
      [{ from: 1, to: 1, insert: "B" }],
      "composition",
      "comp_session_2",
    );
    expect(owner.getDocument("ime.ts")).toBe("AB");
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 1 });

    // Finalizing session 2 correctly closes it
    owner.finalizeComposition("ime.ts", "comp_session_2");
    owner.dispatchTransaction(
      "ime.ts",
      "primary",
      [{ from: 2, to: 2, insert: "C" }],
      "composition",
      "comp_session_3",
    );
    expect(owner.getHistoryState("ime.ts")).toMatchObject({ undoDepth: 2 });
  });
});


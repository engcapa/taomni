import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceEditHistory,
  buildWorkspacePathSnapshotEdit,
  buildWorkspaceTextSnapshotEdit,
  workspaceEditUndoPrecondition,
} from "./workspaceEditHistory";

describe("WorkspaceEditHistory", () => {
  it("groups one multi-file transaction and moves it between stacks", async () => {
    const calls: string[] = [];
    const history = new WorkspaceEditHistory();
    history.push({
      id: "edit-1",
      label: "Rename symbol",
      affectedPaths: ["a.ts", "b.ts"],
      undo: async () => { calls.push("undo"); },
      redo: async () => { calls.push("redo"); },
    });

    expect(history.state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "Rename symbol",
    });
    expect(await history.undo()).toMatchObject({ action: "undo" });
    expect(calls).toEqual(["undo"]);
    expect(history.state()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: "Rename symbol" });
    expect(await history.redo()).toMatchObject({ action: "redo" });
    expect(calls).toEqual(["undo", "redo"]);
  });

  it("keeps a failed action on its original stack", async () => {
    const undo = vi.fn(async () => { throw new Error("changed on disk"); });
    const history = new WorkspaceEditHistory();
    history.push({ id: "edit-1", label: "Format", affectedPaths: ["a.ts"], undo, redo: async () => {} });

    await expect(history.undo()).rejects.toThrow("changed on disk");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, busy: false });
  });

  it("clears redo when a new transaction is pushed and respects the limit", async () => {
    const history = new WorkspaceEditHistory(2);
    const entry = (id: string) => ({ id, label: id, affectedPaths: [], undo: async () => {}, redo: async () => {} });
    history.push(entry("one"));
    history.push(entry("two"));
    history.push(entry("three"));
    expect(history.state().undoLabel).toBe("three");
    await history.undo();
    expect(history.state().redoLabel).toBe("three");
    history.push(entry("four"));
    expect(history.state()).toMatchObject({ canRedo: false, undoLabel: "four" });
  });
});

describe("buildWorkspacePathSnapshotEdit", () => {
  it("restores rename-like path changes by deleting, creating, then writing", () => {
    const edit = buildWorkspacePathSnapshotEdit(
      [
        { path: "/repo/old.ts", exists: false, text: null },
        { path: "/repo/new.ts", exists: true, text: "new contents" },
      ],
      [
        { path: "/repo/old.ts", exists: true, text: "old contents" },
        { path: "/repo/new.ts", exists: false, text: null },
      ],
    );

    expect(edit.operations?.map((operation) => operation.kind)).toEqual([
      "delete",
      "create",
      "text",
    ]);
    expect(edit.documentEdits[0]?.edits[0]?.newText).toBe("old contents");
  });

  it("ED-FOLLOW-001: single undo of a file move deletes the new path and recreates the old one", () => {
    // A1 record: the live single-undo path already reverses relocations via
    // snapshot replay (deletes run before creates so the swap cannot
    // collide); the gap this card closes is crash-recovery blindness, not
    // the undo replay itself.
    const edit = buildWorkspacePathSnapshotEdit(
      [
        { path: "/repo/Old.java", exists: false, text: null },
        { path: "/repo/New.java", exists: true, text: "class New {}" },
      ],
      [
        { path: "/repo/Old.java", exists: true, text: "class Old {}" },
        { path: "/repo/New.java", exists: false, text: null },
      ],
    );
    const kinds = edit.operations?.map((operation) => operation.kind);
    expect(kinds).toEqual(["delete", "create", "text"]);
    const deleteOp = edit.operations?.[0];
    const createOp = edit.operations?.[1];
    expect(deleteOp).toMatchObject({ kind: "delete", path: "/repo/New.java" });
    expect(createOp).toMatchObject({ kind: "create", path: "/repo/Old.java" });
    expect(edit.documentEdits).toHaveLength(1);
    expect(edit.documentEdits[0]?.path).toBe("/repo/Old.java");
    expect(edit.documentEdits[0]?.edits[0]?.newText).toBe("class Old {}");
  });

  it("rejects directory or special-resource snapshots", () => {
    expect(() => buildWorkspacePathSnapshotEdit(
      [{ path: "/repo/src", exists: false, text: null }],
      [{ path: "/repo/src", exists: true, text: null }],
    )).toThrow("non-file resource");
  });
});

describe("buildWorkspaceTextSnapshotEdit", () => {
  it("creates full-document replacements with CRLF-aware positions", () => {
    const edit = buildWorkspaceTextSnapshotEdit(
      [
        { path: "/tmp/a.ts", text: "one\r\ntwo\r\n" },
        { path: "/tmp/b.ts", text: "single" },
      ],
      [
        { path: "/tmp/a.ts", text: "old" },
        { path: "/tmp/b.ts", text: "target" },
      ],
    );
    expect(edit.operations).toHaveLength(2);
    expect(edit.documentEdits[0]?.edits[0]?.range.end).toEqual({ line: 2, character: 0 });
    expect(edit.documentEdits[1]?.edits[0]?.range.end).toEqual({ line: 0, character: 6 });
  });
});

describe("workspaceEditUndoPrecondition (ED-AUDIT-014)", () => {
  const recorded = [
    { path: "/repo/a.ts", exists: true, text: "after refactor" },
    { path: "/repo/b.ts", exists: true, text: "after refactor b" },
  ];

  it("allows undo when every recorded text still matches the current content", () => {
    const result = workspaceEditUndoPrecondition(recorded, {
      "/repo/a.ts": "after refactor",
      "/repo/b.ts": "after refactor b",
    });
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("blocks undo when a later edit changed a recorded file", () => {
    const result = workspaceEditUndoPrecondition(recorded, {
      "/repo/a.ts": "user typed after the refactor",
      "/repo/b.ts": "after refactor b",
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons[0]).toContain("/repo/a.ts");
    expect(result.reasons[0]).toContain("changed after the recorded state");
  });

  it("blocks undo when a recorded file is unreadable or missing", () => {
    const result = workspaceEditUndoPrecondition(recorded, {
      "/repo/a.ts": "after refactor",
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons[0]).toContain("unreadable");
  });

  it("skips recorded non-existence when checking preconditions", () => {
    // A file recorded as absent (text: null) has no recorded text to protect.
    const result = workspaceEditUndoPrecondition(
      [{ path: "/repo/removed.ts", exists: false, text: null }],
      {},
    );
    expect(result.blocked).toBe(false);
  });
});

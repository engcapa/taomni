import { describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceEdit,
  buildWorkspaceEditApplyResultV2,
  classifyWorkspaceEditOperationRetry,
  retryOpenBufferSave,
  WorkspaceEditOpenBufferSaveFailure,
  type WorkspaceEditApplyOutcome,
} from "../../workspaceEditApply";
import { workspaceEditOperations } from "../../workspaceEditPreview";
import { committedDisk, edit } from "./harness";

export function registerworkspaceEditApplyEditing3Cases() {

  describe("ED-REPAIR-001: Buffer edit save failure retry safety", () => {
    it.each(["text", "key", "version", "revision", "closed"])("rejects %s changes during the retry disk read", async (change) => {
      let live: { text: string; dirty: boolean; key: string; version: number; revision: number; } | null = {
        text: "foobar", dirty: true, key: "foo", version: 1, revision: 2,
      };
      const save = vi.fn(async () => { });
      const outcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: { uri: "file:///repo/foo.ts", path: "/repo/foo.ts", edits: [] },
        expectedPostText: "foobar",
        hooks: {
          resolvePath: (doc) => doc.path,
          getOpenBuffer: () => live,
          applyToOpenBuffer: vi.fn(),
          saveOpenBuffer: save,
          readDisk: async () => {
            await Promise.resolve();
            if (change === "closed") live = null;
            else live = { ...live!, [change]: change === "text" ? "foobar NEW" : change === "key" ? "new-session" : 3 };
            return { text: "foo", hash: "pre" };
          },
          writeDisk: async () => committedDisk(),
        },
      });
      expect(outcome).toMatchObject({ status: "failed", diskEffect: "none", bufferEffect: "performed" });
      expect(save).not.toHaveBeenCalled();
    });

    it("captures post-image and buffer identities on known-zero open buffer save failure and classifies as retry-save-only (ED-REPAIR-001-A1)", async () => {
      let openBufferText = "foo";
      let openBufferDirty = false;
      const fooEdit = {
        documentEdits: [{
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "foobar",
          }],
        }],
      };
      const outcomes = await applyWorkspaceEdit(fooEdit, {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: openBufferText, dirty: openBufferDirty, key: "key-foo", version: 1 }),
        applyToOpenBuffer: (_key, nextText) => {
          openBufferText = nextText;
          openBufferDirty = true;
        },
        saveOpenBuffer: async () => {
          throw new WorkspaceEditOpenBufferSaveFailure("readonly disk", "none");
        },
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
      });

      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome).toMatchObject({
        operationIndex: 0,
        path: "/repo/foo.ts",
        status: "failed",
        bufferEffect: "performed",
        diskEffect: "none",
        expectedPostText: "foobar",
        openBufferKey: "key-foo",
        openBufferVersion: 1,
      });
      // The buffer in memory holds foobar
      expect(openBufferText).toBe("foobar");
      expect(classifyWorkspaceEditOperationRetry(outcome)).toBe("retry-save-only");
    });

    it("retryOpenBufferSave persists post-image to disk without re-applying text edits (ED-REPAIR-001-A1)", async () => {
      let openBufferText = "foobar";
      let openBufferDirty = true;
      let diskSavedText: string | null = null;
      const saveHook = vi.fn(async (_key: string, nextText: string) => {
        diskSavedText = nextText;
        openBufferDirty = false;
      });

      const retryOutcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: {
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "foobar",
          }],
        },
        expectedPostText: "foobar",
        expectedKey: "key-foo",
        expectedVersion: 1,
        hooks: {
          resolvePath: (file) => file.path,
          getOpenBuffer: () => ({ text: openBufferText, dirty: openBufferDirty, key: "key-foo", version: 1 }),
          applyToOpenBuffer: (_key, nextText) => {
            openBufferText = nextText;
          },
          saveOpenBuffer: saveHook,
          readDisk: async () => ({ text: "foo", hash: "hash-foo" }),
          writeDisk: async () => committedDisk(),
        },
      });

      expect(retryOutcome).toMatchObject({
        operationIndex: 0,
        path: "/repo/foo.ts",
        status: "applied-open",
        dirty: false,
        bufferEffect: "performed",
      });
      expect(saveHook).toHaveBeenCalledWith("key-foo", "foobar");
      expect(diskSavedText).toBe("foobar");
      // foobar NEVER becomes foobarbar!
      expect(openBufferText).toBe("foobar");
    });

    it("retryOpenBufferSave refuses to save when buffer text changed due to new typing (ED-REPAIR-001-A2)", async () => {
      const saveHook = vi.fn(async () => { });
      const retryOutcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: {
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "foobar",
          }],
        },
        expectedPostText: "foobar",
        expectedKey: "key-foo",
        expectedVersion: 1,
        hooks: {
          resolvePath: (file) => file.path,
          getOpenBuffer: () => ({ text: "foobar-new-typing", dirty: true, key: "key-foo", version: 1 }),
          applyToOpenBuffer: () => { },
          saveOpenBuffer: saveHook,
          readDisk: async () => ({ text: "foo", hash: "hash-foo" }),
          writeDisk: async () => committedDisk(),
        },
      });

      expect(retryOutcome.status).toBe("failed");
      expect("reason" in retryOutcome && retryOutcome.reason).toContain("new user typing detected");
      expect(saveHook).not.toHaveBeenCalled();
    });

    it("retryOpenBufferSave refuses to save when disk precondition fails (ED-REPAIR-001-A2)", async () => {
      const saveHook = vi.fn(async () => { });
      const retryOutcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: {
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "foobar",
          }],
        },
        expectedPostText: "foobar",
        expectedKey: "key-foo",
        expectedVersion: 1,
        hooks: {
          resolvePath: (file) => file.path,
          getOpenBuffer: () => ({ text: "foobar", dirty: true, key: "key-foo", version: 1 }),
          applyToOpenBuffer: () => { },
          saveOpenBuffer: saveHook,
          readDisk: async () => {
            throw new Error("external disk hash changed since preview");
          },
          writeDisk: async () => committedDisk(),
        },
      });

      expect(retryOutcome.status).toBe("failed");
      expect("reason" in retryOutcome && retryOutcome.reason).toContain("disk precondition check failed");
      expect(saveHook).not.toHaveBeenCalled();
    });

    it("retryOpenBufferSave refuses to save when buffer is closed or session changed (ED-REPAIR-001-A2)", async () => {
      const saveHook = vi.fn(async () => { });
      const closedOutcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: {
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [],
        },
        expectedPostText: "foobar",
        expectedKey: "key-foo",
        hooks: {
          resolvePath: (file) => file.path,
          getOpenBuffer: () => null,
          applyToOpenBuffer: () => { },
          saveOpenBuffer: saveHook,
          readDisk: async () => ({ text: "foo", hash: "hash-foo" }),
          writeDisk: async () => committedDisk(),
        },
      });
      expect(closedOutcome.status).toBe("failed");
      expect("reason" in closedOutcome && closedOutcome.reason).toContain("no longer open");

      const sessionChangedOutcome = await retryOpenBufferSave({
        operationIndex: 0,
        document: {
          uri: "file:///repo/foo.ts",
          path: "/repo/foo.ts",
          edits: [],
        },
        expectedPostText: "foobar",
        expectedKey: "key-foo",
        hooks: {
          resolvePath: (file) => file.path,
          getOpenBuffer: () => ({ text: "foobar", dirty: true, key: "key-foo-reopened" }),
          applyToOpenBuffer: () => { },
          saveOpenBuffer: saveHook,
          readDisk: async () => ({ text: "foo", hash: "hash-foo" }),
          writeDisk: async () => committedDisk(),
        },
      });
      expect(sessionChangedOutcome.status).toBe("failed");
      expect("reason" in sessionChangedOutcome && sessionChangedOutcome.reason).toContain("session changed");
      expect(saveHook).not.toHaveBeenCalled();
    });

    it("classifyWorkspaceEditOperationRetry refuses blind retry for unknown disk effects (ED-REPAIR-001-A1)", () => {
      expect(classifyWorkspaceEditOperationRetry({
        operationIndex: 0,
        path: "/repo/foo.ts",
        status: "failed",
        reason: "write ack lost",
        diskEffect: "unknown",
        bufferEffect: "performed",
      })).toBe("unretryable");

      expect(classifyWorkspaceEditOperationRetry({
        operationIndex: 0,
        path: "/repo/foo.ts",
        status: "failed",
        reason: "preflight error",
        diskEffect: "none",
        bufferEffect: "none",
      })).toBe("retry-full");
    });

    it("reconciles multi-operation retry settling all operations into committed without duplicate effects (ED-REPAIR-001-A2)", () => {
      const operations = workspaceEditOperations({
        documentEdits: [
          edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
          edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!,
          edit("file:///repo/c.ts", "/repo/c.ts", "C").documentEdits[0]!,
        ],
      });

      // Initial pass: op 0 applied, op 1 failed known-zero
      const initialOutcomes: WorkspaceEditApplyOutcome[] = [
        { operationIndex: 0, path: "/repo/a.ts", status: "applied-open", dirty: false, bufferEffect: "performed" },
        { operationIndex: 1, path: "/repo/b.ts", status: "failed", reason: "save failed", diskEffect: "none", bufferEffect: "performed", expectedPostText: "B" },
      ];
      const initialResult = buildWorkspaceEditApplyResultV2({
        transactionId: "tx-multi",
        operations,
        outcomes: initialOutcomes,
      });
      expect(initialResult.disposition).toBe("partial");
      expect(initialResult.nextOperationIndex).toBe(1);
      expect(initialResult.effects).toHaveLength(2);
      expect(initialResult.effects[1]!.bufferEffect).toBe("performed");
      expect(initialResult.effects[1]!.diskEffect).toBe("none");

      // Retry pass: op 1 retried successfully, op 2 executed and applied
      const settledOutcomes: WorkspaceEditApplyOutcome[] = [
        ...initialOutcomes,
        { operationIndex: 1, path: "/repo/b.ts", status: "applied-open", dirty: false, bufferEffect: "performed" },
        { operationIndex: 2, path: "/repo/c.ts", status: "applied-disk", result: committedDisk("/repo/c.ts") },
      ];
      const finalResult = buildWorkspaceEditApplyResultV2({
        transactionId: "tx-multi",
        operations,
        outcomes: settledOutcomes,
      });
      expect(finalResult.disposition).toBe("committed");
      expect(finalResult.nextOperationIndex).toBeNull();
      expect(finalResult.resumeToken).toBeNull();
      expect(finalResult.effects).toHaveLength(3);
      expect(finalResult.effects.map((e) => e.operationId)).toEqual([
        "tx-multi:op-0",
        "tx-multi:op-1",
        "tx-multi:op-2",
      ]);
    });
  });

  describe("ED-REPAIR-002: assertTextDocumentPreconditions hook in applyWorkspaceEdit", () => {
    it("fails with zero effects when assertTextDocumentPreconditions throws on op 0 (ED-REPAIR-002-A1)", async () => {
      const applyToOpenBuffer = vi.fn();
      const saveOpenBuffer = vi.fn();
      const readDisk = vi.fn();
      const writeDisk = vi.fn();

      const outcomes = await applyWorkspaceEdit(
        {
          documentEdits: [
            edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
            edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!,
          ],
        },
        {
          resolvePath: (file) => file.path,
          getOpenBuffer: (path) => ({ text: "orig", dirty: false, key: `key:${path}` }),
          applyToOpenBuffer,
          saveOpenBuffer,
          readDisk,
          writeDisk,
          assertTextDocumentPreconditions: (path) => {
            if (path === "/repo/a.ts") {
              throw new Error("precondition failed on a.ts");
            }
          },
        },
      );

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        operationIndex: 0,
        path: "/repo/a.ts",
        status: "failed",
        reason: "precondition failed on a.ts",
        diskEffect: "none",
        bufferEffect: "none",
      });
      expect(applyToOpenBuffer).not.toHaveBeenCalled();
      expect(saveOpenBuffer).not.toHaveBeenCalled();
      expect(readDisk).not.toHaveBeenCalled();
      expect(writeDisk).not.toHaveBeenCalled();
    });

    it("preserves op 0 effects when assertTextDocumentPreconditions fails on op 1 (ED-REPAIR-002-A2)", async () => {
      const applyToOpenBuffer = vi.fn();
      const saveOpenBuffer = vi.fn();
      const readDisk = vi.fn();
      const writeDisk = vi.fn();

      const outcomes = await applyWorkspaceEdit(
        {
          documentEdits: [
            edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
            edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!,
          ],
        },
        {
          resolvePath: (file) => file.path,
          getOpenBuffer: (path) => ({ text: "orig", dirty: false, key: `key:${path}` }),
          applyToOpenBuffer,
          saveOpenBuffer,
          readDisk,
          writeDisk,
          assertTextDocumentPreconditions: (path) => {
            if (path === "/repo/b.ts") {
              throw new Error("buffer revision mismatch on b.ts");
            }
          },
        },
      );

      expect(outcomes).toHaveLength(2);
      // Op 0 succeeded
      expect(outcomes[0]).toMatchObject({
        operationIndex: 0,
        path: "/repo/a.ts",
        status: "applied-open",
      });
      // Op 1 failed with zero effect
      expect(outcomes[1]).toMatchObject({
        operationIndex: 1,
        path: "/repo/b.ts",
        status: "failed",
        reason: "buffer revision mismatch on b.ts",
        diskEffect: "none",
        bufferEffect: "none",
      });
      expect(applyToOpenBuffer).toHaveBeenCalledTimes(1);
      expect(applyToOpenBuffer).toHaveBeenCalledWith("key:/repo/a.ts", "Arig");
    });
  });
}

import { describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceEdit,
  buildWorkspaceEditApplyResultV2,
  classifyWorkspaceEditOperationRetry,
  parseWorkspaceEditResumeToken,
  retryOpenBufferSave,
  sliceWorkspaceEditForResume,
  summarizeWorkspaceEditOutcomes,
  workspaceEditApplyResponse,
  WorkspaceEditOpenBufferSaveFailure,
  type WorkspaceEditApplyOutcome,
} from "./workspaceEditApply";
import { workspaceEditOperations } from "./workspaceEditPreview";
import { buildFinalBytesReceipt, buildPreparedSave, type SaveCommitResult } from "./saveCommit";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";

/** Typed success result for closed-file writeDisk hooks (§8.19.1). */
function committedDisk(path = "/repo/b.ts"): SaveCommitResult {
  const transactionId = "tx-test";
  const prepared = buildPreparedSave({
    transactionId,
    workspaceId: "ws-test",
    fileKey: `closed:${path}`,
    filePath: path,
    text: "",
    bufferRevision: 0,
    styleGeneration: 0,
    expectedDiskHash: null,
    policy: { eol: "lf", encoding: "UTF-8", bom: false },
  });
  const receipt = buildFinalBytesReceipt(prepared, {
    writtenHash: "written",
    writtenByteLength: 0,
    intentHash: "written",
    oldHash: null,
  }, { committedAt: 1 });
  return {
    kind: "saved-current",
    transactionId,
    diskEffect: "committed",
    memoryEffect: "saved-current",
    providerEffect: "not-sent",
    file: { path, text: "", encoding: "UTF-8", bom: false, size: 0, mtime: 0, hash: "written" },
    receipt,
  };
}

function edit(uri: string, path: string, newText: string): LspWorkspaceEdit {
  return {
    documentEdits: [{
      uri,
      path,
      edits: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        newText,
      }],
    }],
  };
}

describe("applyWorkspaceEdit", () => {
  it("applies edits to open dirty buffers without saving or writing disk", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {});
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/a.ts", "/repo/a.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: true, key: "k1" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("k1", "Z = 1");
    expect(saveOpenBuffer).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: true });
  });

  it("applies edits to open clean buffers then saves so the buffer stays clean", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {});
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/clean.ts", "/repo/clean.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: false, key: "clean-key" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("clean-key", "Z = 1");
    expect(saveOpenBuffer).toHaveBeenCalledWith("clean-key", "Z = 1");
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: false });
  });

  // ED-AUDIT-003: a failed open-clean save must surface as a failed outcome,
  // never a phantom "applied-open" — the buffer changed but the disk did not.
  it("reports a failed outcome when the open-clean save rejects (readonly disk)", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {
      throw new Error("Permission denied (os error 13)");
    });
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/ro.ts", "/repo/ro.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: false, key: "ro-key" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("ro-key", "Z = 1");
    expect(saveOpenBuffer).toHaveBeenCalledWith("ro-key", "Z = 1");
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      path: "/repo/ro.ts",
      reason: "Permission denied (os error 13)",
    });
  });

  it("writes unopened files via disk hooks with hash", async () => {
    const writeDisk = vi.fn(async () => committedDisk());
    const saveOpenBuffer = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer,
        readDisk: async () => ({ text: "x", hash: "h1" }),
        writeDisk,
      },
    );
    expect(writeDisk).toHaveBeenCalledWith("/repo/b.ts", "Y", "h1", undefined, undefined, "lf");
    expect(saveOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-disk" });
  });

  it("preserves CRLF and CR line endings when applying LSP edits to closed files", async () => {
    const writeDisk = vi.fn(async () => committedDisk("/repo/crlf.ts"));
    const outcomes = await applyWorkspaceEdit(
      {
        documentEdits: [{
          uri: "file:///repo/crlf.ts",
          path: "/repo/crlf.ts",
          edits: [{
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            newText: "inserted_line\n",
          }],
        }],
      },
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {},
        readDisk: async () => ({
          text: "line1\r\nline2\r\n",
          hash: "h-crlf",
          eol: "crlf",
        }),
        writeDisk,
      },
    );
    expect(outcomes[0]).toMatchObject({ status: "applied-disk" });
    expect(writeDisk).toHaveBeenCalledWith(
      "/repo/crlf.ts",
      "line1\r\ninserted_line\r\nline2\r\n",
      "h-crlf",
      undefined,
      undefined,
      "crlf",
    );
  });

  it("records failures without rolling back prior successes", async () => {
    const saveOpenBuffer = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit(
      {
        documentEdits: [
          {
            uri: "file:///repo/ok.ts",
            path: "/repo/ok.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "A",
            }],
          },
          {
            uri: "file:///repo/bad.ts",
            path: "/repo/bad.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "B",
            }],
          },
        ],
      },
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: (path) => path.endsWith("ok.ts")
          ? { text: "x", dirty: false, key: "ok" }
          : null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer,
        readDisk: async (path) => {
          if (path.endsWith("bad.ts")) throw new Error("hash mismatch");
          return { text: "x", hash: "h" };
        },
        writeDisk: async () => committedDisk(),
      },
    );
    // Open-clean path applied and saved.
    expect(saveOpenBuffer).toHaveBeenCalledWith("ok", "A");
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: false });
    expect(outcomes[1]).toMatchObject({ status: "failed", reason: "hash mismatch" });
    expect(summarizeWorkspaceEditOutcomes(outcomes)).toContain("Applied 1");
  });

  it("asks for a multi-file preview before the first mutation", async () => {
    const confirmWorkspaceEdit = vi.fn(async () => false);
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit: LspWorkspaceEdit = {
      documentEdits: [edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
        edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!],
    };
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: (path) => ({ text: "x", dirty: true, key: path }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      confirmWorkspaceEdit,
    });

    expect(confirmWorkspaceEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        affectedFileCount: 2,
        requiresConfirmation: true,
      }),
      expect.anything(),
    );
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "WorkspaceEdit preview was declined" });
  });

  it("runs the final consistency preflight after confirmation and before mutation", async () => {
    const calls: string[] = [];
    const workspaceEdit: LspWorkspaceEdit = {
      documentEdits: [
        edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
        edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!,
      ],
    };
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "open" }),
      applyToOpenBuffer: () => { calls.push("apply"); },
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      confirmWorkspaceEdit: async () => {
        calls.push("confirm");
        return true;
      },
      preflightMutation: () => {
        calls.push("preflight");
        throw new Error("semantic snapshot changed");
      },
    });

    expect(calls).toEqual(["confirm", "preflight"]);
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: "semantic snapshot changed",
    });
    expect(summarizeWorkspaceEditOutcomes(outcomes)).toContain("semantic snapshot changed");
  });

  it("rejects out-of-scope semantic operations before confirmation or mutation", async () => {
    const confirmWorkspaceEdit = vi.fn(async () => true);
    const applyToOpenBuffer = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///outside/a.ts", "/outside/a.ts", "A"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: true, key: "outside" }),
        applyToOpenBuffer,
        saveOpenBuffer: async () => {},
        readDisk: async () => ({ text: "x", hash: "h" }),
        writeDisk: async () => committedDisk(),
        confirmWorkspaceEdit,
        validateOperationPaths: () => "Semantic WorkspaceEdit path is outside the workspace: /outside/a.ts",
      },
    );
    expect(confirmWorkspaceEdit).not.toHaveBeenCalled();
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("outside the workspace"),
    });
  });

  it("includes change annotations in a preview and only then applies resources", async () => {
    const confirmed: string[] = [];
    const applyToOpenBuffer = vi.fn();
    const createFile = vi.fn(async () => {});
    const workspaceEdit: LspWorkspaceEdit = {
      documentEdits: [],
      operations: [{
        kind: "create",
        uri: "file:///repo/generated.ts",
        path: "/repo/generated.ts",
        overwrite: false,
        ignoreIfExists: false,
        annotationId: "generated",
      }],
      changeAnnotations: [{
        id: "generated",
        label: "Generate source",
        needsConfirmation: true,
        description: "Creates a new source file.",
      }],
    };
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => null,
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      createFile,
      confirmWorkspaceEdit: async (preview) => {
        confirmed.push(preview.annotations[0]?.label ?? "");
        return true;
      },
      confirmChangeAnnotations: async () => {
        throw new Error("the preview should own annotation confirmation");
      },
    });

    expect(confirmed).toEqual(["Generate source"]);
    expect(createFile).toHaveBeenCalledOnce();
    expect(outcomes[0]).toMatchObject({ status: "applied-create" });
  });

  it("marks open-clean apply as failed when saveOpenBuffer throws", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {
      throw new Error("disk full");
    });
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/c.ts", "/repo/c.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "c" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalled();
    expect(saveOpenBuffer).toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "disk full" });
  });

  // ED-MAIN-001: a clean-buffer edit mutates memory before the awaited save.
  // When the save fails the outcome must expose the performed buffer effect so
  // the shell can report "buffer performed, disk none" instead of zero effect.
  it("reports the performed buffer effect when an open-clean save fails (ED-MAIN-001)", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {
      throw new Error("disk full");
    });
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/effect.ts", "/repo/effect.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "effect" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("effect", "Z");
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: "disk full",
      bufferEffect: "performed",
    });
  });

  it("reports an unknown disk effect plus the performed buffer effect (ED-MAIN-001)", async () => {
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/unknown-buffer.ts", "/repo/unknown-buffer.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "unknown-buffer" }),
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {
          throw new WorkspaceEditOpenBufferSaveFailure("write acknowledgement lost", "unknown");
        },
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
      },
    );
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      diskEffect: "unknown",
      bufferEffect: "performed",
    });
  });

  it("keeps zero buffer effect when the edit resolves to identical text and the save fails (ED-MAIN-001)", async () => {
    const applyToOpenBuffer = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/same.ts", "/repo/same.ts", "x"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "same" }),
        applyToOpenBuffer,
        saveOpenBuffer: async () => {
          throw new WorkspaceEditOpenBufferSaveFailure("readonly", "none");
        },
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
      },
    );
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      diskEffect: "none",
      bufferEffect: "none",
    });
  });

  it("keeps a pre-mutation failure at zero buffer effect (ED-MAIN-001)", async () => {
    const applyToOpenBuffer = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/stale.ts", "/repo/stale.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "stale" }),
        applyToOpenBuffer,
        saveOpenBuffer: async () => {},
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
        preflightMutation: () => {
          throw new Error("semantic snapshot changed");
        },
      },
    );
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "semantic snapshot changed" });
    expect((outcomes[0] as { bufferEffect?: string }).bufferEffect).toBeUndefined();
  });

  it("rejects a stale versioned TextDocumentEdit before changing the buffer", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/versioned.ts", "/repo/versioned.ts", "Z");
    workspaceEdit.documentEdits[0]!.version = 4;
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "versioned", version: 5 }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });

    expect(outcomes[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("version mismatch") });
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
  });

  it("applies a TextDocumentEdit whose version matches the open LSP document", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/versioned.ts", "/repo/versioned.ts", "Z");
    workspaceEdit.documentEdits[0]!.version = 5;
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({
        text: "x",
        dirty: true,
        key: "versioned",
        version: 5,
        lspSynced: true,
      }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });

    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: true });
    expect(applyToOpenBuffer).toHaveBeenCalledWith("versioned", "Z");
  });

  it("rejects a versioned edit while matching-version buffer text is still syncing", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/versioned.ts", "/repo/versioned.ts", "Z");
    workspaceEdit.documentEdits[0]!.version = 5;
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({
        text: "locally edited",
        dirty: true,
        key: "versioned",
        version: 5,
        lspSynced: false,
      }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });

    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("unsynchronized buffer changes"),
    });
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
  });

  it("confirms referenced change annotations before applying any edit", async () => {
    const calls: string[] = [];
    const workspaceEdit = edit("file:///repo/annotated.ts", "/repo/annotated.ts", "Z");
    workspaceEdit.documentEdits[0]!.annotationIds = ["generated-change"];
    workspaceEdit.changeAnnotations = [{
      id: "generated-change",
      label: "Update generated source",
      needsConfirmation: true,
      description: "The file is generated",
    }];
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "annotated" }),
      applyToOpenBuffer: () => { calls.push("apply"); },
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      confirmChangeAnnotations: async (annotations) => {
        calls.push(`confirm:${annotations[0]?.id}`);
        return true;
      },
    });

    expect(calls).toEqual(["confirm:generated-change", "apply"]);
    expect(outcomes[0]).toMatchObject({ status: "applied-open" });
  });

  it("does not mutate when change annotation confirmation is declined", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/annotated.ts", "/repo/annotated.ts", "Z");
    workspaceEdit.documentEdits[0]!.annotationIds = ["destructive"];
    workspaceEdit.changeAnnotations = [{
      id: "destructive",
      label: "Rewrite generated source",
      needsConfirmation: true,
      description: null,
    }];
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "annotated" }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      confirmChangeAnnotations: async () => false,
    });

    expect(outcomes[0]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("declined"),
    });
    expect(workspaceEditApplyResponse(outcomes)).toEqual({
      applied: false,
      failureReason: "WorkspaceEdit change confirmation was declined",
      failedChange: null,
    });
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
  });

  it("treats an empty TextDocumentEdit as a successful no-op", async () => {
    const createFile = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit({
      documentEdits: [],
      operations: [
        {
          kind: "text",
          document: {
            uri: "file:///repo/unchanged.ts",
            path: "/repo/unchanged.ts",
            edits: [],
          },
        },
        {
          kind: "create",
          uri: "file:///repo/created.ts",
          path: "/repo/created.ts",
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        },
      ],
    }, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => null,
      applyToOpenBuffer: () => {},
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
      createFile,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["noop", "applied-create"]);
    expect(workspaceEditApplyResponse(outcomes)).toEqual({
      applied: true,
      failureReason: null,
      failedChange: null,
    });
    expect(createFile).toHaveBeenCalledOnce();
  });

  it("rejects an annotation id that is absent from changeAnnotations", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/annotated.ts", "/repo/annotated.ts", "Z");
    workspaceEdit.documentEdits[0]!.annotationIds = ["missing"];
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "annotated" }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });

    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("unknown change annotation: missing"),
    });
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
  });

  it("preserves documentChanges order across resource and text operations", async () => {
    const calls: string[] = [];
    const outcomes = await applyWorkspaceEdit(
      {
        documentEdits: [],
        operations: [
          {
            kind: "create",
            uri: "file:///repo/new.ts",
            path: "/repo/new.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          },
          {
            kind: "text",
            document: {
              uri: "file:///repo/new.ts",
              path: "/repo/new.ts",
              edits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "content",
              }],
            },
          },
          {
            kind: "rename",
            oldUri: "file:///repo/new.ts",
            oldPath: "/repo/new.ts",
            newUri: "file:///repo/final.ts",
            newPath: "/repo/final.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          },
          {
            kind: "delete",
            uri: "file:///repo/final.ts",
            path: "/repo/final.ts",
            recursive: false,
            ignoreIfNotExists: false,
            annotationId: null,
          },
        ],
      },
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {},
        readDisk: async () => ({ text: "", hash: "created" }),
        writeDisk: async () => { calls.push("text"); return committedDisk("/repo/new.ts"); },
        createFile: async () => { calls.push("create"); },
        renameFile: async () => { calls.push("rename"); },
        deleteFile: async () => { calls.push("delete"); },
      },
    );

    expect(calls).toEqual(["create", "text", "rename", "delete"]);
    expect(outcomes.map((item) => item.status)).toEqual([
      "applied-create",
      "applied-disk",
      "applied-rename",
      "applied-delete",
    ]);
  });

  it("reports the resource operation that failed without rolling back earlier changes", async () => {
    const deleteFile = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit(
      {
        documentEdits: [],
        operations: [
          {
            kind: "create",
            uri: "file:///repo/ok.ts",
            path: "/repo/ok.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          },
          {
            kind: "rename",
            oldUri: "file:///repo/missing.ts",
            oldPath: "/repo/missing.ts",
            newUri: "file:///repo/final.ts",
            newPath: "/repo/final.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          },
          {
            kind: "delete",
            uri: "file:///repo/final.ts",
            path: "/repo/final.ts",
            recursive: false,
            ignoreIfNotExists: false,
            annotationId: null,
          },
        ],
      },
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {},
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
        createFile: async () => {},
        renameFile: async () => { throw new Error("source is missing"); },
        deleteFile,
      },
    );

    expect(outcomes[0]?.status).toBe("applied-create");
    expect(outcomes[1]).toMatchObject({ status: "failed", reason: "source is missing" });
    expect(workspaceEditApplyResponse(outcomes)).toEqual({
      applied: false,
      failureReason: "source is missing",
      failedChange: 1,
    });
    expect(outcomes).toHaveLength(2);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("applies filtered WorkspaceEdit when confirmation hook filters out specific usages", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {});
    const editWithTwoFiles: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///repo/a.ts",
          path: "/repo/a.ts",
          edits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
          ],
        },
        {
          uri: "file:///repo/b.ts",
          path: "/repo/b.ts",
          edits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "B" },
          ],
        },
      ],
    };

    const outcomes = await applyWorkspaceEdit(
      editWithTwoFiles,
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: (p) => ({ text: "x = 1", dirty: false, key: p }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
        confirmWorkspaceEdit: async (_preview, original) => {
          // Filter out b.ts
          return {
            ...original,
            documentEdits: [original.documentEdits[0]],
          };
        },
      },
    );

    expect(outcomes).toHaveLength(1);
    expect(applyToOpenBuffer).toHaveBeenCalledTimes(1);
    expect(applyToOpenBuffer).toHaveBeenCalledWith("/repo/a.ts", "A = 1");
  });

  it("reports unknown closed-file writes as failed with a recovery hint (§8.19.1)", async () => {
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/unknown.ts", "/repo/unknown.ts", "U"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {},
        readDisk: async () => ({ text: "x", hash: "h" }),
        writeDisk: async () => ({
          kind: "failed",
          transactionId: "tx-unk",
          diskEffect: "unknown",
          memoryEffect: "unchanged",
          providerEffect: "unknown",
          error: { kind: "io", message: "rename temp file: EBUSY", effect: "unknown" },
          recoveryId: "tx-unk",
        }),
      },
    );
    expect(outcomes[0]).toMatchObject({ status: "failed" });
    expect((outcomes[0] as { reason: string }).reason).toContain("result unknown");
    expect((outcomes[0] as { reason: string }).reason).toContain("recovery center");
    expect(workspaceEditApplyResponse(outcomes).applied).toBe(false);
  });

  it("carries the typed committed result on applied-disk outcomes", async () => {
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer: async () => {},
        readDisk: async () => ({ text: "x", hash: "h1" }),
        writeDisk: async () => committedDisk(),
      },
    );
    const diskOutcome = outcomes[0] as Extract<
      Awaited<ReturnType<typeof applyWorkspaceEdit>>[number],
      { status: "applied-disk" }
    >;
    expect(diskOutcome.result?.diskEffect).toBe("committed");
    if (diskOutcome.result?.kind === "saved-current") {
      expect(diskOutcome.result.file.hash).toBe("written");
    } else {
      throw new Error("expected a saved-current result on the applied-disk outcome");
    }
  });

  it("builds per-operation effects, dispositions and resume boundaries (§8.19.1)", async () => {
    const twoFileEdit: LspWorkspaceEdit = {
      documentEdits: [
        edit("file:///repo/ok.ts", "/repo/ok.ts", "A").documentEdits[0]!,
        edit("file:///repo/bad.ts", "/repo/bad.ts", "B").documentEdits[0]!,
      ],
    };
    // Operation 0 applies to an open dirty buffer; operation 1 fails on disk
    // read — the run stops at that boundary with a resume token.
    const outcomes = await applyWorkspaceEdit(twoFileEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: (path) => path.endsWith("ok.ts") ? { text: "x", dirty: true, key: "ok" } : null,
      applyToOpenBuffer: () => {},
      saveOpenBuffer: async () => {},
      readDisk: async (path) => {
        if (path.endsWith("bad.ts")) throw new Error("disk unavailable");
        return { text: "x", hash: "h" };
      },
      writeDisk: async () => committedDisk(),
    });
    const partialResult = buildWorkspaceEditApplyResultV2({
      transactionId: "tx-v2b",
      operations: workspaceEditOperations(twoFileEdit),
      outcomes,
      undoAvailability: () => "available",
    });
    expect(partialResult.disposition).toBe("partial");
    expect(partialResult.nextOperationIndex).toBe(1);
    expect(parseWorkspaceEditResumeToken(partialResult.resumeToken ?? ""))
      .toEqual({ transactionId: "tx-v2b", operationIndex: 1 });
    expect(partialResult.effects).toHaveLength(2);
    expect(partialResult.effects[0]).toMatchObject({
      operationId: "tx-v2b:op-0",
      kind: "text",
      targetPath: "/repo/ok.ts",
      result: null,
      undoState: "available",
    });
    expect(partialResult.effects[1]).toMatchObject({
      kind: "text",
      targetPath: "/repo/bad.ts",
      result: null,
      undoState: "unavailable",
    });

    // A fully settled run commits without a boundary.
    const settled = await applyWorkspaceEdit(twoFileEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "k" }),
      applyToOpenBuffer: () => {},
      saveOpenBuffer: async () => {},
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });
    const committedResult = buildWorkspaceEditApplyResultV2({
      transactionId: "tx-v2c",
      operations: workspaceEditOperations(twoFileEdit),
      outcomes: settled,
    });
    expect(committedResult.disposition).toBe("committed");
    expect(committedResult.nextOperationIndex).toBeNull();
  });

  it("resume slicing keeps only the unapplied suffix of the applied edit", () => {
    const multiEdit: LspWorkspaceEdit = {
      documentEdits: [
        edit("file:///repo/a.ts", "/repo/a.ts", "A").documentEdits[0]!,
        edit("file:///repo/b.ts", "/repo/b.ts", "B").documentEdits[0]!,
        edit("file:///repo/c.ts", "/repo/c.ts", "C").documentEdits[0]!,
      ],
    };
    const sliced = sliceWorkspaceEditForResume(multiEdit, 1);
    expect(sliced.documentEdits.map((document) => document.path)).toEqual(["/repo/b.ts", "/repo/c.ts"]);

    const explicitOperations: LspWorkspaceEdit = {
      documentEdits: [],
      operations: [
        { kind: "create", uri: "", path: "/r/n.ts", overwrite: false, ignoreIfExists: false, annotationId: null },
        { kind: "delete", uri: "", path: "/r/o.ts", recursive: false, ignoreIfNotExists: false, annotationId: null },
      ],
    };
    const slicedOps = sliceWorkspaceEditForResume(explicitOperations, 1);
    expect(slicedOps.operations?.map((operation) => operation.kind)).toEqual(["delete"]);
  });

  it("maps pre-mutation refusals to cancelled and blocked dispositions", () => {
    const operations = workspaceEditOperations(edit("file:///repo/a.ts", "/repo/a.ts", "A"));
    const cancelledResult = buildWorkspaceEditApplyResultV2({
      transactionId: "tx-c",
      operations,
      outcomes: [{ operationIndex: null, path: "WorkspaceEdit", status: "skipped", reason: "declined" }],
    });
    expect(cancelledResult.disposition).toBe("cancelled");
    expect(cancelledResult.effects).toHaveLength(0);

    const blockedResult = buildWorkspaceEditApplyResultV2({
      transactionId: "tx-b",
      operations,
      outcomes: [{ operationIndex: null, path: "WorkspaceEdit", status: "failed", reason: "stale" }],
    });
    expect(blockedResult.disposition).toBe("blocked");
    expect(blockedResult.resumeToken).toBeNull();
  });

  it("commits the whole transaction when every operation settles (§8.19.1)", () => {
    const result = buildWorkspaceEditApplyResultV2({
      transactionId: "tx-full",
      operations: workspaceEditOperations(edit("file:///repo/a.ts", "/repo/a.ts", "A")),
      outcomes: [{ operationIndex: 0, path: "/repo/a.ts", status: "applied-open", dirty: true }],
      undoAvailability: () => "unavailable",
    });
    expect(result.disposition).toBe("committed");
    expect(result.nextOperationIndex).toBeNull();
    expect(result.resumeToken).toBeNull();
    expect(result.effects[0]).toMatchObject({
      operationId: "tx-full:op-0",
      kind: "text",
      targetPath: "/repo/a.ts",
      result: null,
      undoState: "unavailable",
    });
  });

  describe("ED-REPAIR-001: Buffer edit save failure retry safety", () => {
    it.each(["text", "key", "version", "revision", "closed"])("rejects %s changes during the retry disk read", async (change) => {
      let live: { text: string; dirty: boolean; key: string; version: number; revision: number } | null = {
        text: "foobar", dirty: true, key: "foo", version: 1, revision: 2,
      };
      const save = vi.fn(async () => {});
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
      const saveHook = vi.fn(async () => {});
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
          applyToOpenBuffer: () => {},
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
      const saveHook = vi.fn(async () => {});
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
          applyToOpenBuffer: () => {},
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
      const saveHook = vi.fn(async () => {});
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
          applyToOpenBuffer: () => {},
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
          applyToOpenBuffer: () => {},
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
});

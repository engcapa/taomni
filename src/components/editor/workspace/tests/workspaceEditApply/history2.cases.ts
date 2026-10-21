import { expect, it, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import {
  applyWorkspaceEdit,
  buildWorkspaceEditApplyResultV2,
  parseWorkspaceEditResumeToken,
  sliceWorkspaceEditForResume,
  workspaceEditApplyResponse,
} from "../../workspaceEditApply";
import { workspaceEditOperations } from "../../workspaceEditPreview";
import { committedDisk, edit } from "./harness";

export function registerworkspaceEditApplyHistory2Cases() {

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
      saveOpenBuffer: async () => { },
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
      saveOpenBuffer: async () => { },
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
    const createFile = vi.fn(async () => { });
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
      applyToOpenBuffer: () => { },
      saveOpenBuffer: async () => { },
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
      saveOpenBuffer: async () => { },
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
        applyToOpenBuffer: () => { },
        saveOpenBuffer: async () => { },
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
    const deleteFile = vi.fn(async () => { });
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
        applyToOpenBuffer: () => { },
        saveOpenBuffer: async () => { },
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
        createFile: async () => { },
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
    const saveOpenBuffer = vi.fn(async () => { });
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
        applyToOpenBuffer: () => { },
        saveOpenBuffer: async () => { },
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
    expect((outcomes[0] as { reason: string; }).reason).toContain("result unknown");
    expect((outcomes[0] as { reason: string; }).reason).toContain("recovery center");
    expect(workspaceEditApplyResponse(outcomes).applied).toBe(false);
  });

  it("carries the typed committed result on applied-disk outcomes", async () => {
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => { },
        saveOpenBuffer: async () => { },
        readDisk: async () => ({ text: "x", hash: "h1" }),
        writeDisk: async () => committedDisk(),
      },
    );
    const diskOutcome = outcomes[0] as Extract<
      Awaited<ReturnType<typeof applyWorkspaceEdit>>[number],
      { status: "applied-disk"; }
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
      applyToOpenBuffer: () => { },
      saveOpenBuffer: async () => { },
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
      applyToOpenBuffer: () => { },
      saveOpenBuffer: async () => { },
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
}

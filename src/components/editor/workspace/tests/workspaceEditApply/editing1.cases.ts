import { expect, it, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { applyWorkspaceEdit, summarizeWorkspaceEditOutcomes, WorkspaceEditOpenBufferSaveFailure } from "../../workspaceEditApply";
import { committedDisk, edit } from "./harness";

export function registerworkspaceEditApplyEditing1Cases() {
  it("applies edits to open dirty buffers without saving or writing disk", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => { });
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
    const saveOpenBuffer = vi.fn(async () => { });
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
    const saveOpenBuffer = vi.fn(async () => { });
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => { },
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
        applyToOpenBuffer: () => { },
        saveOpenBuffer: async () => { },
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
    const saveOpenBuffer = vi.fn(async () => { });
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
        applyToOpenBuffer: () => { },
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
      saveOpenBuffer: async () => { },
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
      saveOpenBuffer: async () => { },
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
        saveOpenBuffer: async () => { },
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
    const createFile = vi.fn(async () => { });
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
      saveOpenBuffer: async () => { },
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
        applyToOpenBuffer: () => { },
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
        saveOpenBuffer: async () => { },
        readDisk: async () => null,
        writeDisk: async () => committedDisk(),
        preflightMutation: () => {
          throw new Error("semantic snapshot changed");
        },
      },
    );
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "semantic snapshot changed" });
    expect((outcomes[0] as { bufferEffect?: string; }).bufferEffect).toBeUndefined();
  });

  it("rejects a stale versioned TextDocumentEdit before changing the buffer", async () => {
    const applyToOpenBuffer = vi.fn();
    const workspaceEdit = edit("file:///repo/versioned.ts", "/repo/versioned.ts", "Z");
    workspaceEdit.documentEdits[0]!.version = 4;
    const outcomes = await applyWorkspaceEdit(workspaceEdit, {
      resolvePath: (file) => file.path,
      getOpenBuffer: () => ({ text: "x", dirty: true, key: "versioned", version: 5 }),
      applyToOpenBuffer,
      saveOpenBuffer: async () => { },
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
      saveOpenBuffer: async () => { },
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
      saveOpenBuffer: async () => { },
      readDisk: async () => null,
      writeDisk: async () => committedDisk(),
    });

    expect(outcomes[0]).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("unsynchronized buffer changes"),
    });
    expect(applyToOpenBuffer).not.toHaveBeenCalled();
  });
}

import { describe, expect, it, vi } from "vitest";
import { makeLoadingFile, type OpenFileState } from "../codeWorkspaceModel";
import { createRestoreEchoSuppressor } from "../refactorRecoveryController";
import { createHandleExternalFileChange, type HandleExternalFileChangeContext } from "./externalFileChanges";
import type { ExternalDiskSnapshot } from "./model";

function scenario(dirty = false) {
  const file: OpenFileState = {
    ...makeLoadingFile({ kind: "root", rootId: "app", path: "Main.java" }, [], []),
    loading: false, text: dirty ? "local draft" : "saved", savedText: "saved", hash: "saved-hash", dirty,
  };
  const disk: ExternalDiskSnapshot = { text: "saved", hash: "saved-hash", eol: "LF", encoding: "UTF-8", bom: false, mtime: 2, size: 5 };
  const openFilesRef = { current: { [file.key]: file } };
  const context: HandleExternalFileChangeContext = {
    workspaceStyleControllerRef: { current: { invalidate: vi.fn() } } as unknown as HandleExternalFileChangeContext["workspaceStyleControllerRef"],
    semanticIndex: { invalidate: vi.fn() } as unknown as HandleExternalFileChangeContext["semanticIndex"],
    openFilesRef, absolutePathForOpenFile: () => "C:/repo/Main.java", refreshTree: vi.fn(),
    restoreEchoSuppressorRef: { current: createRestoreEchoSuppressor() }, setStatusMessage: vi.fn(),
    enqueueExternalFileConflict: vi.fn(), applyDiskSnapshot: vi.fn(),
    setOpenFiles: (update) => { openFilesRef.current = typeof update === "function" ? update(openFilesRef.current) : update; },
    readDiskSnapshot: vi.fn(async () => disk),
  };
  const change = { workspaceId: "workspace", path: "C:/repo/Main.java", type: 3 as const };
  return { file, disk, context, change, handle: createHandleExternalFileChange(context) };
}

describe("external file notifications after atomic replacement", () => {
  it.each([false, true])("preserves an accepted disk snapshot and a dirty=%s buffer after a delayed delete echo", async (dirty) => {
    const { context, change, handle, file } = scenario(dirty);
    await handle(change);
    expect(context.openFilesRef.current[file.key]).toMatchObject({ text: file.text, dirty, error: null, mtime: 2 });
    expect(context.setStatusMessage).not.toHaveBeenCalled();
    expect(context.enqueueExternalFileConflict).not.toHaveBeenCalled();
    expect(context.semanticIndex.invalidate).not.toHaveBeenCalled();
  });

  it("reloads a clean buffer when the replacement contains new bytes", async () => {
    const { context, change, handle, disk, file } = scenario();
    Object.assign(disk, { text: "external replacement", hash: "external-hash" });
    await handle(change);
    expect(context.applyDiskSnapshot).toHaveBeenCalledWith(file, disk);
    expect(context.setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("Reloaded"));
  });

  it("offers conflict recovery when replacement bytes differ from a local draft", async () => {
    const { context, change, handle, disk, file } = scenario(true);
    Object.assign(disk, { text: "external replacement", hash: "external-hash" });
    await handle(change);
    expect(context.enqueueExternalFileConflict).toHaveBeenCalledWith(file, disk);
    expect(context.applyDiskSnapshot).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a genuinely deleted dirty=%s buffer recoverable", async (dirty) => {
    const { context, change, handle, file } = scenario(dirty);
    vi.mocked(context.readDiskSnapshot).mockRejectedValue(new Error("File not found"));
    await handle(change);
    expect(context.openFilesRef.current[file.key].text).toBe(file.text);
    expect(context.setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("deleted on disk"));
    if (dirty) expect(context.enqueueExternalFileConflict).toHaveBeenCalledWith(file, null);
    else expect(context.openFilesRef.current[file.key].error).toContain("deleted on disk");
  });

  it("does not resurrect a buffer closed while verifying a delete notification", async () => {
    const { context, change, handle, file, disk } = scenario();
    vi.mocked(context.readDiskSnapshot).mockImplementation(async () => {
      delete context.openFilesRef.current[file.key];
      return disk;
    });
    await handle(change);
    expect(context.openFilesRef.current[file.key]).toBeUndefined();
    expect(context.setStatusMessage).not.toHaveBeenCalled();
  });
});

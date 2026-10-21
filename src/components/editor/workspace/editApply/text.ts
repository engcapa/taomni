import type { LspFileTextEdits } from "../../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "../lspTextEdits";
import { normalizeLineEndings } from "../saveNormalizationPipeline";
import { type WorkspaceEditApplyHooks, type WorkspaceEditApplyOutcome, WorkspaceEditOpenBufferSaveFailure } from "./model";

export async function applyTextDocumentEdit(
  file: LspFileTextEdits,
  operationIndex: number,
  hooks: WorkspaceEditApplyHooks,
): Promise<WorkspaceEditApplyOutcome> {
  const path = hooks.resolvePath(file);
  if (!path) {
    return { operationIndex, path: file.uri, status: "skipped", reason: "unresolvable path" };
  }
  if (!file.edits.length) return { operationIndex, path, status: "noop" };
  // ED-MAIN-001: track the in-memory mutation separately from the disk result
  // so a failed save after `applyToOpenBuffer` still reports the buffer effect.
  let bufferMutated = false;
  let expectedPostText: string | undefined;
  let openBufferKey: string | undefined;
  let openBufferVersion: number | null | undefined;
  try {
    const open = hooks.getOpenBuffer(path);
    if (hooks.assertTextDocumentPreconditions) {
      try {
        hooks.assertTextDocumentPreconditions(path, open);
      } catch (error) {
        return {
          operationIndex,
          path,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          diskEffect: "none",
          bufferEffect: "none",
        };
      }
    }
    if (file.version != null && !open) {
      return {
        operationIndex,
        path,
        status: "failed",
        reason: `versioned document ${file.version} is not open`,
      };
    }
    if (open) {
      if (file.version != null && open.version !== file.version) {
        return {
          operationIndex,
          path,
          status: "failed",
          reason: `document version mismatch (expected ${file.version}, current ${open.version ?? "unknown"})`,
        };
      }
      if (file.version != null && open.lspSynced !== true) {
        return {
          operationIndex,
          path,
          status: "failed",
          reason: `document version ${file.version} has unsynchronized buffer changes`,
        };
      }
      const next = applyLspTextEditsToString(open.text, file.edits);
      const changed = next !== open.text;
      expectedPostText = next;
      openBufferKey = open.key;
      openBufferVersion = open.version;
      hooks.assertMutationBoundary?.();
      if (!open.dirty) {
        hooks.applyToOpenBuffer(open.key, next);
        bufferMutated = changed;
        await hooks.saveOpenBuffer(open.key, next);
        return {
          operationIndex,
          path,
          status: "applied-open",
          dirty: false,
          bufferEffect: changed ? "performed" : "none",
        };
      }
      hooks.applyToOpenBuffer(open.key, next);
      bufferMutated = changed;
      return {
        operationIndex,
        path,
        status: "applied-open",
        dirty: true,
        bufferEffect: changed ? "performed" : "none",
      };
    }
    const disk = await hooks.readDisk(path);
    if (!disk) {
      return { operationIndex, path, status: "failed", reason: "file not found on disk" };
    }
    const diskEol: "lf" | "crlf" | "cr" =
      disk.eol ??
      (disk.text.includes("\r\n") ? "crlf" : disk.text.includes("\r") && !disk.text.includes("\n") ? "cr" : "lf");
    const nextRaw = applyLspTextEditsToString(disk.text, file.edits);
    const next = normalizeLineEndings(nextRaw, diskEol);
    hooks.assertTextDocumentPreconditions?.(path, hooks.getOpenBuffer(path));
    hooks.assertMutationBoundary?.();
    // §8.19.1: the shared committer's typed result decides the outcome — an
    // uncertain write is never reported as applied.
    const writeResult = await hooks.writeDisk(path, next, disk.hash, disk.encoding, disk.bom, diskEol);
    if (writeResult.diskEffect === "committed") {
      return { operationIndex, path, status: "applied-disk", result: writeResult };
    }
    const failureReason = writeResult.kind === "cancelled"
      ? `closed-file write cancelled before write: ${writeResult.reason}`
      : writeResult.error.message;
    return {
      operationIndex,
      path,
      status: "failed",
      reason: writeResult.diskEffect === "unknown"
        ? `${failureReason}; result unknown — resolve the file in the recovery center before retrying`
        : failureReason,
      diskEffect: writeResult.diskEffect === "unknown" ? "unknown" : "none",
    };
  } catch (error) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof WorkspaceEditOpenBufferSaveFailure
        ? { diskEffect: error.diskEffect }
        : {}),
      // ED-MAIN-001: a clean-buffer save that rejects after the buffer write
      // has already happened must carry the performed buffer effect; a
      // pre-mutation failure stays at zero effect.
      ...(bufferMutated || error instanceof WorkspaceEditOpenBufferSaveFailure
        ? { bufferEffect: bufferMutated ? ("performed" as const) : ("none" as const) }
        : {}),
      ...(bufferMutated ? {
        expectedPostText,
        openBufferKey,
        openBufferVersion,
      } : {}),
    };
  }
}

import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { buildFinalBytesReceipt, buildPreparedSave, type SaveCommitResult } from "../../saveCommit";

/** Typed success result for closed-file writeDisk hooks (§8.19.1). */
export function committedDisk(path = "/repo/b.ts"): SaveCommitResult {
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

export function edit(uri: string, path: string, newText: string): LspWorkspaceEdit {
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

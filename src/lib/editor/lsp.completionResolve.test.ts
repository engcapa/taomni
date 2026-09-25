import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lspCompletionResolve,
  type LspDocumentDescriptor,
  type LspCompletionItem,
} from "./lsp";

/**
 * ED-PARITY-005 D1: the completionItem/resolve IPC boundary must preserve the
 * provider outcome identity instead of collapsing everything into a null item
 * that the caller would treat as "no additional edits".
 */

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

const descriptor: LspDocumentDescriptor = {
  workspaceId: "ws-parity005",
  rootPath: "/parity005",
  filePath: "/parity005/src/main/java/parity005/Main.java",
  languageId: "java",
};

const item: LspCompletionItem = {
  label: "StringUtils",
  kind: 7,
  detail: "org.apache.commons.lang3.StringUtils",
  documentation: null,
  insertText: "StringUtils",
  insertTextFormat: 1,
  filterText: null,
  sortText: "0001",
  textEdit: {
    range: { start: { line: 4, character: 8 }, end: { line: 4, character: 17 } },
    newText: "StringUtils",
  },
  insertReplaceEdit: {
    newText: "StringUtils",
    insert: { start: { line: 4, character: 8 }, end: { line: 4, character: 17 } },
    replace: { start: { line: 4, character: 8 }, end: { line: 4, character: 23 } },
  },
  additionalTextEdits: [],
  raw: { label: "StringUtils" },
};

describe("ED-PARITY-005 completion resolve IPC", () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
  });

  it("preserves resolved unavailable timeout failed across IPC", async () => {
    coreMocks.invoke.mockResolvedValueOnce({ kind: "resolved", item });
    await expect(lspCompletionResolve(descriptor, item.raw)).resolves.toEqual({
      kind: "resolved",
      item,
    });

    coreMocks.invoke.mockResolvedValueOnce({ kind: "unavailable", reason: "no-active-provider" });
    await expect(lspCompletionResolve(descriptor, item.raw)).resolves.toEqual({
      kind: "unavailable",
      reason: "no-active-provider",
    });

    coreMocks.invoke.mockResolvedValueOnce({ kind: "timeout" });
    await expect(lspCompletionResolve(descriptor, item.raw)).resolves.toEqual({ kind: "timeout" });

    coreMocks.invoke.mockResolvedValueOnce({ kind: "failed", message: "server closed request" });
    await expect(lspCompletionResolve(descriptor, item.raw)).resolves.toEqual({
      kind: "failed",
      message: "server closed request",
    });

    // The command name and the original raw item travel unchanged; the raw item
    // is what the provider resolves, never a client-side reconstruction.
    expect(coreMocks.invoke).toHaveBeenCalledTimes(4);
    for (const call of coreMocks.invoke.mock.calls) {
      expect(call[0]).toBe("lsp_completion_resolve");
      expect((call[1] as { item: unknown }).item).toEqual(item.raw);
    }
  });
});

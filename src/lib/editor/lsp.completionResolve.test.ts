import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lspCompletionResolve,
  normalizeCompletionResolveWire,
  type LspCompletionItem,
  type LspDocumentDescriptor,
} from "./lsp";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

const descriptor: LspDocumentDescriptor = {
  workspaceId: "ws-005",
  rootPath: "/repo",
  filePath: "/repo/parity005/Main.java",
  languageId: "java",
};

function makeItem(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return {
    label: "StringUtils",
    kind: 7,
    detail: "org.apache.commons.lang3.StringUtils",
    documentation: null,
    insertText: null,
    insertTextFormat: 1,
    filterText: null,
    sortText: "0001",
    textEdit: {
      range: { start: { line: 4, character: 8 }, end: { line: 4, character: 17 } },
      newText: "StringUtils",
    },
    additionalTextEdits: [],
    raw: { label: "StringUtils" },
    ...overrides,
  };
}

describe("ED-PARITY-005 preserves resolved unavailable timeout failed across IPC", () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
  });

  it("passes through the typed resolved envelope without inventing imports", async () => {
    const item = makeItem({
      additionalTextEdits: [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
          newText: "import org.apache.commons.lang3.StringUtils;\n",
        },
      ],
    });
    coreMocks.invoke.mockResolvedValue({ kind: "resolved", item });
    const result = await lspCompletionResolve(descriptor, { label: "StringUtils" });
    expect(coreMocks.invoke).toHaveBeenCalledWith(
      "lsp_completion_resolve",
      expect.objectContaining({ filePath: descriptor.filePath }),
    );
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.item.additionalTextEdits).toHaveLength(1);
    }
  });

  it("keeps unavailable/timeout/failed distinct instead of falling back to the original", async () => {
    coreMocks.invoke.mockResolvedValueOnce({ kind: "unavailable", reason: "resolver-returned-null" });
    expect((await lspCompletionResolve(descriptor, {})).kind).toBe("unavailable");

    coreMocks.invoke.mockResolvedValueOnce({ kind: "timeout", message: "timed out" });
    const timeout = await lspCompletionResolve(descriptor, {});
    expect(timeout.kind).toBe("timeout");

    coreMocks.invoke.mockResolvedValueOnce({ kind: "failed", message: "broken pipe" });
    const failed = await lspCompletionResolve(descriptor, {});
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.message).toContain("broken pipe");
    }
  });

  it("normalizes a legacy bare item/null wire without masking provider null", () => {
    const legacy = makeItem();
    const normalized = normalizeCompletionResolveWire(legacy);
    expect(normalized.kind).toBe("resolved");
    if (normalized.kind === "resolved") {
      expect(normalized.item.label).toBe("StringUtils");
    }
    expect(normalizeCompletionResolveWire(null).kind).toBe("unavailable");
    expect(normalizeCompletionResolveWire(undefined).kind).toBe("unavailable");
    // A legacy numeric `kind` must not be mistaken for the typed envelope.
    expect(normalizeCompletionResolveWire(legacy).kind).toBe("resolved");
  });
});

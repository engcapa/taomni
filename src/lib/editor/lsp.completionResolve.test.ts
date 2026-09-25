import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lspCompletionResolve,
  type LspCompletionItem,
  type LspCompletionResolveResult,
  type LspDocumentDescriptor,
} from "./lsp";
import {
  classifyCompletionResolveOutcome,
  createLspCompletionSource,
  executeCompletionResolve,
  normalizeCompletionResolveReply,
  type CompletionRequestToken,
} from "../../components/editor/workspace/lspCompletion";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

const descriptor: LspDocumentDescriptor = {
  workspaceId: "ws-parity005",
  rootPath: "/repo",
  filePath: "/repo/parity005/Main.java",
  languageId: "java",
};

function item(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return {
    label: "StringUtils",
    kind: 7,
    detail: "org.apache.commons.lang3.StringUtils",
    documentation: null,
    insertText: "StringUtils",
    insertTextFormat: 1,
    filterText: null,
    sortText: "0001",
    textEdit: null,
    additionalTextEdits: [],
    raw: { label: "StringUtils" },
    ...overrides,
  };
}

const TOKEN: CompletionRequestToken = {
  requestId: "parity005-1",
  workspaceId: "ws-parity005",
  fileKey: "parity005/Main.java",
  filePath: "parity005/Main.java",
  uri: "file:///parity005/Main.java",
  languageId: "java",
  documentRevision: 0,
  lspSessionGeneration: 1,
};

describe("ED-PARITY-005 resolve wire/outcome bridge", () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
  });

  // ED-PARITY-005 D1: every tagged backend outcome has to survive the IPC hop
  // unchanged. Before the typed result the host could only answer "item or
  // null", so a failure and an unattempted resolve looked identical.
  it("preserves resolved unavailable timeout failed across IPC", async () => {
    const replies: LspCompletionResolveResult[] = [
      { kind: "resolved", item: item() },
      { kind: "unavailable", reason: "provider-returned-null" },
      { kind: "timeout" },
      { kind: "failed", message: "Method not found" },
    ];

    for (const reply of replies) {
      coreMocks.invoke.mockResolvedValueOnce(reply);
      await expect(lspCompletionResolve(descriptor, { label: "StringUtils" }))
        .resolves.toEqual(reply);
      expect(coreMocks.invoke).toHaveBeenLastCalledWith("lsp_completion_resolve", expect.objectContaining({
        workspaceId: "ws-parity005",
        rootPath: "/repo",
        filePath: "/repo/parity005/Main.java",
        languageId: "java",
        // The raw provider item is echoed back verbatim so the server can
        // resolve the exact candidate the user saw.
        item: { label: "StringUtils" },
      }));
    }
  });

  // The classification the gate and the acceptance path branch on, driven by
  // the same replies the backend now produces.
  it("classifies each wire reply without inventing a resolution", () => {
    expect(classifyCompletionResolveOutcome({
      item: item(),
      hasResolver: true,
      resolvedItem: item(),
    }).kind).toBe("resolved");

    expect(classifyCompletionResolveOutcome({
      item: item(),
      hasResolver: true,
      resolvedItem: null,
      unavailableReason: "provider-returned-null",
    })).toMatchObject({ kind: "unavailable", reason: "provider-returned-null" });

    expect(classifyCompletionResolveOutcome({
      item: item(),
      hasResolver: true,
      timedOut: true,
    }).kind).toBe("timeout");

    expect(classifyCompletionResolveOutcome({
      item: item(),
      hasResolver: true,
      error: "Method not found",
    })).toMatchObject({ kind: "failed", error: "Method not found" });

    // A reply that already carried its own additional edits is still
    // not-required, and a missing resolver is still unavailable — neither
    // degenerates into a fake resolution.
    expect(classifyCompletionResolveOutcome({
      item: item(),
      hasResolver: false,
    })).toMatchObject({ kind: "unavailable", reason: "missing-resolver" });
  });

  it("maps each tagged reply to the acceptance outcome", async () => {
    const run = async (reply: LspCompletionResolveResult) => executeCompletionResolve({
      item: item(),
      resolve: async () => reply,
      token: TOKEN,
      isStillCurrent: () => true,
      getDocumentRevision: () => 0,
    });

    await expect(run({ kind: "resolved", item: item({ detail: "resolved" }) }))
      .resolves.toMatchObject({ kind: "resolved" });
    await expect(run({ kind: "unavailable", reason: "resolve-unsupported" }))
      .resolves.toMatchObject({ kind: "unavailable", reason: "resolve-unsupported" });
    await expect(run({ kind: "timeout" })).resolves.toMatchObject({ kind: "timeout" });
    await expect(run({ kind: "failed", message: "Method not found" }))
      .resolves.toMatchObject({ kind: "failed", error: "Method not found" });
  });

  // A legacy embedder or fixture that still answers "item or null" keeps
  // working; null stays "nothing usable", never a silent success.
  it("normalises the legacy item-or-null reply", () => {
    expect(normalizeCompletionResolveReply(item())).toMatchObject({ kind: "resolved" });
    expect(normalizeCompletionResolveReply(null))
      .toEqual({ kind: "unavailable", reason: "resolver-returned-null" });
    expect(normalizeCompletionResolveReply({ kind: "timeout" })).toEqual({ kind: "timeout" });
  });

  // End of the chain: a failed resolve must reach the gate instead of
  // committing the unresolved item as though the import had arrived.
  it("routes a failed resolve to the gate instead of committing", async () => {
    const gates: unknown[] = [];
    const view = new (await import("@codemirror/view")).EditorView({
      state: EditorState.create({ doc: "        StringUti" }),
      parent: document.body,
    });
    const source = createLspCompletionSource({
      identity: () => ({
        workspaceId: "ws-parity005",
        fileKey: "parity005/Main.java",
        filePath: "parity005/Main.java",
        uri: "file:///parity005/Main.java",
        languageId: "java",
        documentRevision: 0,
        lspSessionGeneration: 1,
      }),
      fetch: async () => ({
        status: {
          path: "parity005/Main.java", uri: "file:///parity005/Main.java", presetId: "java",
          languageId: "java", displayName: "Java", available: true, active: true,
          selectedCommandId: null, selectedCommand: null, installHint: null, error: null,
        },
        isIncomplete: false,
        items: [item()],
      }),
      resolve: async () => ({ kind: "failed", message: "Method not found" }),
      triggerCharacters: () => [],
      getDocumentRevision: () => 0,
      reportDiagnostic: vi.fn(),
      onResolveGate: (request) => gates.push(request),
    });

    const result = (await source(new CompletionContext(view.state, 13, true))) as CompletionResult;
    const option = result.options[0];
    expect(typeof option.apply).toBe("function");
    (option.apply as (v: unknown, o: unknown, f: number, t: number) => void)(
      view, option, 4, 13,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ reason: "failed", item: { label: "StringUtils" } });
    expect(view.state.doc.toString()).toBe("        StringUti");
    view.destroy();
  });
});

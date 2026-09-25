import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { CompletionContext } from "@codemirror/autocomplete";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";
import {
  commitLspCompletion,
  createLspCompletionSource,
  type CompletionRequestIdentity,
  type LspCompletionHooks,
} from "./lspCompletion";

const M0_DOC = "package parity005;\n\npublic class Main {\n    void sample() {\n        StringUtiSuffix;\n    }\n}";

function dualItem(): LspCompletionItem {
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
    insertReplaceEdit: {
      newText: "StringUtils",
      insert: { start: { line: 4, character: 8 }, end: { line: 4, character: 17 } },
      replace: { start: { line: 4, character: 8 }, end: { line: 4, character: 23 } },
    },
    additionalTextEdits: [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        newText: "import org.apache.commons.lang3.StringUtils;\n",
      },
    ],
    raw: { label: "StringUtils" },
  };
}

function mountView(docText: string): EditorView {
  const state = EditorState.create({ doc: docText, extensions: [history()] });
  return new EditorView({ state, parent: document.body });
}

const IDENTITY: CompletionRequestIdentity = {
  workspaceId: "ws-005",
  fileKey: "Main.java",
  filePath: "/repo/Main.java",
  uri: "file:///repo/Main.java",
  languageId: "java",
  documentRevision: 3,
  lspSessionGeneration: 1,
};

function statusActive() {
  return {
    path: "/repo/Main.java",
    uri: "file:///repo/Main.java",
    presetId: "java",
    languageId: "java",
    displayName: "Java",
    available: true,
    active: true,
    selectedCommandId: "jdtls",
    selectedCommand: "jdtls",
    installHint: null,
    error: null,
  };
}

describe("ED-PARITY-005 Enter Tab and mouse route distinct range intent", () => {
  afterEach(cleanup);

  it("insert intent preserves suffix while replace intent consumes it (one undo each)", () => {
    const viewInsert = mountView(M0_DOC);
    const line = viewInsert.state.doc.line(5);
    const token = { ...IDENTITY, requestId: "req-insert" };
    const ok = commitLspCompletion(
      viewInsert, dualItem(), line.from + 8, line.from + 17,
      token, () => true, () => {}, [], "insert",
    );
    expect(ok).toBe(true);
    expect(viewInsert.state.doc.toString()).toContain("StringUtilsSuffix");
    undo(viewInsert);
    expect(viewInsert.state.doc.toString()).toBe(M0_DOC);
    viewInsert.destroy();

    const viewReplace = mountView(M0_DOC);
    const lineR = viewReplace.state.doc.line(5);
    const okR = commitLspCompletion(
      viewReplace, dualItem(), lineR.from + 8, lineR.from + 17,
      { ...IDENTITY, requestId: "req-replace" }, () => true, () => {}, [], "replace",
    );
    expect(okR).toBe(true);
    expect(viewReplace.state.doc.toString()).toContain("StringUtils;");
    expect(viewReplace.state.doc.toString()).not.toContain("StringUtilsSuffix");
    undo(viewReplace);
    expect(viewReplace.state.doc.toString()).toBe(M0_DOC);
    viewReplace.destroy();
  });

  it("host Enter/Tab/mouse intents route through source apply (insert vs replace vs mouse-default)", async () => {
    // Production key handlers do: Enter -> setPending(insert) + acceptCompletion,
    // Tab -> setPending(replace) + acceptCompletion, mouse -> apply with no
    // pending intent (defaults to insert). Exercise the exact same path via
    // the source option apply.
    const { setPendingCompletionAcceptIntent } = await import("./lspCompletion");
    const baseItem: LspCompletionItem = {
      ...dualItem(),
      insertReplaceEdit: undefined,
      additionalTextEdits: [],
    };
    const resolvedItem = dualItem();
    const runApplyWithIntent = async (intent: "insert" | "replace" | null) => {
      const view = mountView(M0_DOC);
      const line = view.state.doc.line(5);
      const source = createLspCompletionSource({
        identity: () => ({ ...IDENTITY }),
        fetch: async () => ({ status: statusActive(), isIncomplete: false, items: [baseItem] }),
        resolve: async () => ({ kind: "resolved", item: resolvedItem }) as never,
        triggerCharacters: () => [],
        getDocumentRevision: () => IDENTITY.documentRevision,
        reportDiagnostic: () => {},
      });
      const result = await source(new CompletionContext(view.state, line.from + 8, true));
      const option = result!.options[0];
      if (intent) setPendingCompletionAcceptIntent(view, intent);
      if (typeof option.apply === "function") {
        option.apply(view, option, line.from + 8, line.from + 17);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      const text = view.state.doc.toString();
      view.destroy();
      return text;
    };
    const enterDoc = await runApplyWithIntent("insert");
    expect(enterDoc).toContain("StringUtilsSuffix");
    expect(enterDoc).toContain("import org.apache.commons.lang3.StringUtils;");
    const tabDoc = await runApplyWithIntent("replace");
    expect(tabDoc).not.toContain("StringUtilsSuffix");
    expect(tabDoc).toContain("StringUtils;");
    const mouseDoc = await runApplyWithIntent(null);
    expect(mouseDoc).toContain("StringUtilsSuffix");
  });

  it("host popup opens for the M0 prefix and Escape leaves the buffer untouched", async () => {
    const M0_BASE = "package parity005;\n\npublic class Main {\n    void sample() {\n        StringUtSuffix;\n    }\n}";
    let revision = 0;
    const baseItem: LspCompletionItem = {
      ...dualItem(),
      insertReplaceEdit: undefined,
      additionalTextEdits: [],
    };
    const complete = vi.fn(async () => ({
      status: statusActive(),
      isIncomplete: false,
      items: [baseItem],
    }));
    const rendered = render(<CodeMirrorHost
      path="Main.java"
      doc={M0_BASE}
      visible
      diagnostics={[]}
      reveal={null}
      onChange={() => { revision += 1; }}
      onSave={vi.fn()}
      onHover={async () => null}
      onDefinition={async () => false}
      onReferences={async () => undefined}
      onComplete={complete}
      onCompleteResolve={async () => null}
      completionTriggers={[]}
      hoverDocumentationDelayMs={0}
      getCompletionIdentity={() => ({
        workspaceId: "ws-005",
        fileKey: "Main.java",
        filePath: "Main.java",
        uri: "file:///Main.java",
        languageId: "java",
        documentRevision: revision,
        lspSessionGeneration: 1,
      })}
      onCompletionDiagnostic={vi.fn()}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    act(() => {
      view.focus();
      const targetLine = view.state.doc.line(5);
      view.dispatch({ selection: { anchor: targetLine.from + 16 } });
    });
    act(() => {
      view.dispatch({
        changes: { from: view.state.selection.main.head, insert: "i" },
        selection: { anchor: view.state.selection.main.head + 1 },
        userEvent: "input.type",
      });
    });
    await waitFor(() => {
      expect(document.querySelector(".cm-tooltip-autocomplete")?.textContent ?? "").toContain("StringUtils");
    });
    fireEvent.keyDown(content, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());
    expect(view.state.doc.toString()).toContain("StringUtiSuffix");
    expect(view.state.doc.toString()).not.toContain("StringUtils");
    rendered.unmount();
    cleanup();
  });
});

describe("ED-PARITY-005 invalidates acceptance when project facts change", () => {
  it("a facts-generation bump rejects the old scope candidate with zero writes", async () => {
    const view = mountView(M0_DOC);
    const line = view.state.doc.line(5);
    let liveGeneration = 7;
    const hooks: LspCompletionHooks = {
      identity: () => ({
        ...IDENTITY,
        documentRevision: 3,
        lspSessionGeneration: 1,
        projectScope: liveGeneration === 7
          ? {
              status: "ready", scope: "module", moduleId: "parity005",
              sourceKind: "main", dependencies: [], classpathFingerprint: "abc", generation: 7,
            }
          : {
              status: "ready", scope: "module", moduleId: "parity005",
              sourceKind: "main", dependencies: [], classpathFingerprint: "abc", generation: 8,
            },
      }),
      fetch: async () => ({
        status: statusActive(),
        isIncomplete: false,
        items: [dualItem()],
      }),
      resolve: async () => ({
        kind: "resolved",
        item: dualItem(),
      }) as never,
      triggerCharacters: () => [],
      getDocumentRevision: () => 3,
      reportDiagnostic: () => {},
    };
    const source = createLspCompletionSource(hooks);
    const result = await source(new CompletionContext(view.state, line.from + 17, true));
    expect(result).not.toBeNull();
    // Facts refresh before acceptance: same file/session/revision, new generation.
    liveGeneration = 8;
    const option = result!.options[0];
    const diagnostics: string[] = [];
    void diagnostics;
    if (typeof option.apply === "function") {
      option.apply(view, option, line.from + 8, line.from + 17);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Stale scope must not commit primary or import.
    expect(view.state.doc.toString()).toBe(M0_DOC);
    view.destroy();
  });
});

describe("ED-PARITY-005 escape cancels pending acceptance without revival", () => {
  it("aborted resolve never commits even when the provider answers late", async () => {
    const { cancelPendingCompletionAcceptance } = await import("./lspCompletion");
    const view = mountView(M0_DOC);
    const line = view.state.doc.line(5);
    // Base item carries no import so acceptance must wait for resolve.
    const baseItem: LspCompletionItem = {
      ...dualItem(),
      insertReplaceEdit: undefined,
      additionalTextEdits: [],
    };
    let release!: (item: LspCompletionItem) => void;
    const held = new Promise<LspCompletionItem>((resolve) => { release = resolve; });
    const gates: Array<{ retry: () => Promise<unknown> }> = [];
    const source = createLspCompletionSource({
      identity: () => ({ ...IDENTITY }),
      fetch: async () => ({ status: statusActive(), isIncomplete: false, items: [baseItem] }),
      resolve: () => held as never,
      triggerCharacters: () => [],
      getDocumentRevision: () => IDENTITY.documentRevision,
      reportDiagnostic: () => {},
      onResolveGate: (request) => gates.push(request),
    });
    const result = await source(new CompletionContext(view.state, line.from + 8, true));
    const option = result!.options[0];
    if (typeof option.apply === "function") {
      option.apply(view, option, line.from + 8, line.from + 17);
    }
    // Escape during resolve waiting aborts the pending acceptance.
    expect(cancelPendingCompletionAcceptance(view)).toBe(true);
    release(dualItem());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(view.state.doc.toString()).toBe(M0_DOC);
    expect(gates).toHaveLength(0);
    view.destroy();
  });
});

describe("ED-PARITY-005 old gate callbacks cannot replace a new gate", () => {
  it("a stale gate retry/dismiss never touches the fresh gate or document", async () => {
    const view = mountView(M0_DOC);
    const line = view.state.doc.line(5);
    const baseItem: LspCompletionItem = {
      ...dualItem(),
      insertReplaceEdit: undefined,
      additionalTextEdits: [],
    };
    const gates: Array<{ retry: () => Promise<string>; insertWithoutImport: () => boolean; dismiss: () => void }> = [];
    const mkSource = (resolveImpl: () => Promise<null>) => createLspCompletionSource({
      identity: () => ({ ...IDENTITY }),
      fetch: async () => ({ status: statusActive(), isIncomplete: false, items: [baseItem] }),
      resolve: resolveImpl as never,
      triggerCharacters: () => [],
      getDocumentRevision: () => IDENTITY.documentRevision,
      reportDiagnostic: () => {},
      onResolveGate: (request) => gates.push(request as never),
    });
    const first = await mkSource(async () => null)(new CompletionContext(view.state, line.from + 8, true));
    const firstOption = first!.options[0];
    if (typeof firstOption.apply === "function") {
      firstOption.apply(view, firstOption, line.from + 8, line.from + 17);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gates).toHaveLength(1);
    const staleGate = gates[0];

    // Second acceptance supersedes the first in the same view.
    const second = await mkSource(async () => null)(new CompletionContext(view.state, line.from + 8, true));
    const secondOption = second!.options[0];
    if (typeof secondOption.apply === "function") {
      secondOption.apply(view, secondOption, line.from + 8, line.from + 17);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gates).toHaveLength(2);

    // Old gate actions are inert; document stays untouched.
    expect(await staleGate.retry()).toBe("unavailable");
    expect(view.state.doc.toString()).toBe(M0_DOC);
    view.destroy();
  });
});

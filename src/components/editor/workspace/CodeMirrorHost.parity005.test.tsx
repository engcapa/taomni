import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem, LspCompletionResolveResult } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { createWorkspaceActionHost } from "./workspaceActionHost";

/**
 * ED-PARITY-005 host-level cases. These drive the real editor surface — real
 * key events on `.cm-content`, real mousedown on the candidate row, the real
 * resolve gate buttons — because handler-only tests cannot prove that the
 * acceptance intent reaches the transaction.
 */

const M0 = [
  "package parity005;",
  "",
  "public class Main {",
  "    void sample() {",
  "        StringUtiSuffix;",
  "    }",
  "}",
  "",
].join("\n");

const WORD_START = M0.indexOf("StringUtiSuffix");
const CARET = WORD_START + "StringUti".length;
const IMPORT_LINE = "import org.apache.commons.lang3.StringUtils;";

function status() {
  return {
    path: "parity005/Main.java", uri: "file:///parity005/Main.java", presetId: "java",
    languageId: "java", displayName: "Java", available: true, active: true,
    selectedCommandId: null, selectedCommand: null, installHint: null, error: null,
  };
}

function item(withImport: boolean): LspCompletionItem {
  const insert = { start: { line: 4, character: 8 }, end: { line: 4, character: 17 } };
  return {
    label: "StringUtils",
    kind: 7,
    detail: "org.apache.commons.lang3.StringUtils",
    // Documented item: the completion-docs path renders without a resolve
    // round-trip, so resolve is called exactly once per acceptance.
    documentation: "StringUtils class documentation",
    insertText: "StringUtils",
    insertTextFormat: 1,
    filterText: null,
    sortText: "0000001",
    textEdit: { range: insert, newText: "StringUtils" },
    insertReplaceEdit: {
      newText: "StringUtils",
      insert,
      replace: { start: { line: 4, character: 8 }, end: { line: 4, character: 23 } },
    },
    additionalTextEdits: withImport
      ? [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: `${IMPORT_LINE}\n` }]
      : [],
    raw: { label: "StringUtils" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  /** Per-round-trip reply; call 0 is the first acceptance's resolve. */
  onResolve?: (callIndex: number) => LspCompletionResolveResult | Promise<LspCompletionResolveResult>;
  /** Item returned by the provider list (before resolve). */
  listed?: LspCompletionItem;
}

function mountHarness(options: HarnessOptions = {}) {
  const changes: string[] = [];
  const diagnostics: string[] = [];
  const gates: unknown[] = [];
  const listed = options.listed ?? item(true);
  const onResolve = options.onResolve ?? (() => ({ kind: "resolved", item: listed }) as const);
  let resolveCalls = 0;

  const complete = vi.fn(async () => ({
    status: status(),
    isIncomplete: false,
    items: [listed],
  }));
  const resolve = vi.fn(async (): Promise<LspCompletionResolveResult> => {
    const call = resolveCalls;
    resolveCalls += 1;
    return onResolve(call);
  });

  const rendered = render(<CodeMirrorHost
    path="parity005/Main.java"
    viewId="view-parity005"
    doc={M0}
    visible
    diagnostics={[]}
    reveal={null}
    onChange={(text: string) => { changes.push(text); }}
    onSave={vi.fn()}
    onHover={async () => null}
    onDefinition={async () => false}
    onReferences={async () => undefined}
    onComplete={complete}
    onCompleteResolve={resolve}
    completionTriggers={["."]}
    hoverDocumentationDelayMs={0}
    getCompletionIdentity={() => ({
      workspaceId: "ws-parity005",
      fileKey: "parity005/Main.java",
      filePath: "parity005/Main.java",
      uri: "file:///parity005/Main.java",
      languageId: "java",
      documentRevision: 0,
      lspSessionGeneration: 1,
    })}
    onCompletionDiagnostic={(kind: string) => { diagnostics.push(kind); }}
    onScopeFallback={(state: unknown) => { gates.push(state); }}
    workspaceActionHost={createWorkspaceActionHost({
      workspaceId: "ws-parity005",
      getContext: () => ({ focus: "editor" }),
      getDefaultContext: () => ({ focus: "editor" }),
      getDefaultFocus: () => "editor",
    })}
  />);

  const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;

  const open = async () => {
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: CARET }, scrollIntoView: true });
    });
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    act(() => { startCompletion(view); });
    await waitFor(() => expect(candidateRows().length).toBeGreaterThan(0));
    // CodeMirror refuses to accept an option that appeared less than
    // interactionDelay ago, so an immediate Enter would fall through to the
    // plain newline binding instead of the acceptance under test.
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 120); });
    });
  };

  /** Move the selection onto the provider row, whatever the local sources added. */
  const selectProviderRow = () => {
    for (let steps = 0; steps < 40; steps += 1) {
      const selected = document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]');
      if (selected?.textContent?.includes("StringUtils")) return selected as HTMLElement;
      fireEvent.keyDown(content, { key: "ArrowDown" });
    }
    throw new Error("provider candidate row not reachable");
  };

  return {
    rendered, content, view, complete, resolve, changes, diagnostics, gates,
    get resolveCalls() { return resolveCalls; },
    get resolveCallCount() { return resolve.mock.calls.length; },
    open, selectProviderRow,
  };
}

function candidateRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete li"));
}

function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const withImportLine = (accepted: string) => M0
  .replace("StringUtiSuffix", accepted)
  .replace("package parity005;\n\n", `package parity005;\n${IMPORT_LINE}\n\n`);
const ENTER_DOC = withImportLine("StringUtilsSuffix");
const TAB_DOC = withImportLine("StringUtils");

afterEach(cleanup);

describe("ED-PARITY-005 host completion acceptance", () => {
  it("ED-PARITY-005 Enter Tab and mouse route distinct range intent", async () => {
    // Enter keeps the word's suffix: the provider's insert range.
    for (const acceptWith of ["Enter", "mouse"] as const) {
      const h = mountHarness();
      await h.open();
      const before = h.changes.length;
      const row = h.selectProviderRow();
      if (acceptWith === "mouse") {
        fireEvent.mouseDown(row, { button: 0 });
      } else {
        fireEvent.keyDown(h.content, { key: acceptWith });
      }
      await waitFor(() => expect(h.view.state.doc.toString()).toBe(ENTER_DOC));
      expect(h.changes.length - before).toBe(1);
      // Caret sits right after the accepted identifier, with no selection.
      expect(h.view.state.selection.main.empty).toBe(true);
      // Caret follows the inserted text; the kept suffix stays after it.
      expect(h.view.state.selection.main.head)
        .toBe(WORD_START + `${IMPORT_LINE}\n`.length + "StringUtils".length);
      // The import landed exactly once.
      expect(h.view.state.doc.toString().split(IMPORT_LINE)).toHaveLength(2);
      // One acceptance is one undo.
      await act(async () => {
        (await import("@codemirror/commands")).undo(h.view);
      });
      expect(h.view.state.doc.toString()).toBe(M0);
      h.rendered.unmount();
    }

    // Tab consumes the whole identifier: the provider's replace range.
    const tab = mountHarness();
    await tab.open();
    const before = tab.changes.length;
    tab.selectProviderRow();
    fireEvent.keyDown(tab.content, { key: "Tab" });
    await waitFor(() => expect(tab.view.state.doc.toString()).toBe(TAB_DOC));
    expect(tab.changes.length - before).toBe(1);
    expect(tab.view.state.doc.toString().split(IMPORT_LINE)).toHaveLength(2);
    await act(async () => {
      (await import("@codemirror/commands")).undo(tab.view);
    });
    expect(tab.view.state.doc.toString()).toBe(M0);
    tab.rendered.unmount();
  });

  it("ED-PARITY-005 invalidates acceptance when project facts change", async () => {
    const held = deferred<LspCompletionResolveResult>();
    // The listed item has no import edits, so the acceptance waits on resolve.
    const h = mountHarness({ listed: item(false), onResolve: () => held.promise });
    await h.open();
    h.selectProviderRow();
    fireEvent.keyDown(h.content, { key: "Enter" });
    await waitFor(() => expect(h.resolve).toHaveBeenCalled());

    // The document moves on while the provider is still answering.
    act(() => {
      h.view.dispatch({
        changes: { from: CARET, insert: "X" },
        selection: { anchor: CARET + 1 },
        userEvent: "input.type",
      });
    });
    await act(async () => {
      held.resolve({ kind: "resolved", item: item(true) });
      await settle();
    });

    expect(h.view.state.doc.toString()).toBe(M0.replace("StringUtiSuffix", "StringUtiXSuffix"));
    expect(h.diagnostics).toContain("identity-mismatch");
    h.rendered.unmount();
  });

  it("ED-PARITY-005 escape cancels pending acceptance without revival", async () => {
    const held = deferred<LspCompletionResolveResult>();
    const h = mountHarness({ listed: item(false), onResolve: () => held.promise });
    await h.open();
    h.selectProviderRow();
    fireEvent.keyDown(h.content, { key: "Enter" });
    await waitFor(() => expect(h.resolve).toHaveBeenCalled());

    fireEvent.keyDown(h.content, { key: "Escape" });
    await act(async () => {
      // The provider answers only after the acceptance was cancelled.
      held.resolve({ kind: "resolved", item: item(true) });
      await settle();
    });

    // Nothing was written and no gate was revived.
    expect(h.view.state.doc.toString()).toBe(M0);
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')).toBeNull();

    // A fresh explicit completion still works afterwards.
    await h.open();
    h.selectProviderRow();
    fireEvent.keyDown(h.content, { key: "Enter" });
    await waitFor(() => expect(h.view.state.doc.toString()).toBe(ENTER_DOC));
    h.rendered.unmount();
  });

  it("ED-PARITY-005 old gate callbacks cannot replace a new gate", async () => {
    // Session A fails its resolve, so its gate is on screen. Its Retry stays
    // pending on `staleA`; session B gets its own independent round-trip.
    const staleA = deferred<LspCompletionResolveResult>();
    const heldB = deferred<LspCompletionResolveResult>();
    const h = mountHarness({
      listed: item(false),
      onResolve: (call) => {
        if (call === 0) return { kind: "failed", message: "Method not found" };
        if (call === 1) return staleA.promise;
        return heldB.promise;
      },
    });
    await h.open();
    h.selectProviderRow();
    fireEvent.keyDown(h.content, { key: "Enter" });
    await waitFor(() => expect(
      document.querySelector('[data-testid="completion-resolve-gate"]'),
    ).not.toBeNull());
    const gateA = document.querySelector('[data-testid="completion-resolve-gate"]')!;
    expect(gateA.textContent).toContain("StringUtils");
    expect(gateA.textContent).toContain("failed");

    // Retry starts a fresh round-trip that stays pending.
    fireEvent.click(document.querySelector('[data-testid="completion-resolve-gate-retry"]')!);
    await waitFor(() => expect(h.resolve.mock.calls.length).toBe(2));
    // While it waits, Retry and the explicit degradation are disabled.
    expect(document.querySelector<HTMLButtonElement>('[data-testid="completion-resolve-gate-retry"]')!.disabled)
      .toBe(true);
    expect(document.querySelector<HTMLButtonElement>(
      '[data-testid="completion-resolve-gate-insert-without-import"]',
    )!.disabled).toBe(true);

    // Dismiss ends session A, then a new acceptance opens its own gate.
    fireEvent.click(document.querySelector('[data-testid="completion-resolve-gate-dismiss"]')!);
    await waitFor(() => expect(
      document.querySelector('[data-testid="completion-resolve-gate"]'),
    ).toBeNull());
    expect(h.view.state.doc.toString()).toBe(M0);

    await h.open();
    h.selectProviderRow();
    fireEvent.keyDown(h.content, { key: "Enter" });
    await waitFor(() => expect(h.resolve.mock.calls.length).toBe(3));
    await act(async () => {
      // The stale retry finally answers after its session was dismissed. It
      // must not commit for session A and must not resurrect its gate.
      staleA.resolve({ kind: "resolved", item: item(true) });
      await settle();
    });
    expect(h.view.state.doc.toString()).toBe(M0);
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')).toBeNull();

    // Session B is still the live one, so its own answer still lands.
    await act(async () => {
      heldB.resolve({ kind: "resolved", item: item(true) });
      await settle();
    });
    expect(h.view.state.doc.toString()).toBe(ENTER_DOC);
    h.rendered.unmount();
  });
});

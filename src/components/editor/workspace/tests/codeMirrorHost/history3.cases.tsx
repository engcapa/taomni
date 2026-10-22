import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import type { GitLineChange } from "../../gitEditorChrome";
import { WorkspaceActionHost } from "../../workspaceActionHost";
import { WorkspaceDocumentTransactionOwner } from "../../workspaceDocumentTransactionOwner";
import { setVirtualOverflow, virtualOverflowAt, virtualSpaceTypingHandler } from "../../workspaceVirtualSpace";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostHistory3Cases() {

  describe("§8.26 ED-MULTIVIEW-002 shared document host wiring", () => {
    afterEach(() => cleanup());

    function sharedProps(
      owner: WorkspaceDocumentTransactionOwner,
      viewId: string,
      doc: string,
      onChange: ComponentProps<typeof CodeMirrorHost>["onChange"],
      workspaceActionHost?: WorkspaceActionHost,
    ): ComponentProps<typeof CodeMirrorHost> {
      return {
        path: "src/shared.ts",
        fileKey: "shared.ts",
        viewId,
        transactionOwner: owner,
        documentRevision: 0,
        doc,
        visible: true,
        diagnostics: [],
        reveal: null,
        onChange,
        onSave: vi.fn(),
        onHover: vi.fn(async () => null),
        onDefinition: vi.fn(async () => false),
        onReferences: vi.fn(async () => undefined),
        getCompletionIdentity: () => null,
        onCompletionDiagnostic: vi.fn(),
        ...(workspaceActionHost ? { workspaceActionHost } : {}),
      };
    }

    it("broadcasts one incremental edit and preserves the sibling selection", () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const initial = "hello world";
      const primaryOnChange = vi.fn();
      const secondaryOnChange = vi.fn();
      const rendered = render(
        <div>
          <CodeMirrorHost {...sharedProps(owner, "primary", initial, primaryOnChange)} />
          <CodeMirrorHost {...sharedProps(owner, "secondary", initial, secondaryOnChange)} />
        </div>,
      );
      const views = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
        .map((element) => EditorView.findFromDOM(element)!);
      const primary = views[0]!;
      const secondary = views[1]!;
      const transactions: Array<{ sourceViewId: string; changes: readonly { from: number; to: number; insert: string; }[]; }> = [];
      const unsubscribe = owner.subscribe("shared.ts", (transaction) => {
        transactions.push(transaction);
      });

      secondary.dispatch({ selection: { anchor: initial.length } });
      primary.dispatch({ changes: { from: 0, to: 0, insert: "say " } });

      expect(primary.state.doc.toString()).toBe("say hello world");
      expect(secondary.state.doc.toString()).toBe("say hello world");
      expect(secondary.state.selection.main.head).toBe(initial.length + 4);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.sourceViewId).toBe("primary");
      expect(transactions[0]?.changes).toEqual([{ from: 0, to: 0, insert: "say " }]);
      expect(primaryOnChange).toHaveBeenCalledTimes(1);
      expect(secondaryOnChange).not.toHaveBeenCalled();
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });
      unsubscribe();
    });

    it("routes undo and redo through the shared owner for both mounted views", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-shared-history" });
      const initial = "hello";
      const rendered = render(
        <div>
          <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)} />
          <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn(), actionHost)} />
        </div>,
      );
      const views = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
        .map((element) => EditorView.findFromDOM(element)!);
      const primary = views[0]!;
      const secondary = views[1]!;
      primary.dispatch({ changes: { from: initial.length, to: initial.length, insert: "!" } });
      expect(primary.state.doc.toString()).toBe("hello!");
      expect(secondary.state.doc.toString()).toBe("hello!");

      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(primary.state.doc.toString()).toBe(initial);
      expect(secondary.state.doc.toString()).toBe(initial);
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: false, canRedo: true });

      await act(async () => {
        const result = await actionHost.execute("workspace.redo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(primary.state.doc.toString()).toBe("hello!");
      expect(secondary.state.doc.toString()).toBe("hello!");
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, canRedo: false });
    });

    // ED-AUDIT-008: the workspace-edit journal claims a stroke before the
    // document ledger. A `true` claim consumes the stroke without touching the
    // ledger; `undefined` hands it back; `false` blocks it while the journal is
    // busy.
    it("ED-AUDIT-008: lets the workspace-edit journal claim undo and redo strokes", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-journal-claim" });
      const initial = "hello";
      const claims: Array<{ action: "undo" | "redo"; result: boolean | undefined; }> = [];
      let nextClaim: boolean | undefined;
      const rendered = render(
        <CodeMirrorHost
          {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)}
          onWorkspaceHistoryClaim={(action) => {
            const result = nextClaim;
            claims.push({ action, result });
            return result;
          }}
        />,
      );
      const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();
      view!.dispatch({ changes: { from: initial.length, to: initial.length, insert: "!" } });
      expect(view!.state.doc.toString()).toBe("hello!");

      // Journal claim: the stroke is consumed and the document ledger keeps
      // its entry.
      nextClaim = true;
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(claims).toEqual([{ action: "undo", result: true }]);
      expect(view!.state.doc.toString()).toBe("hello!");
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

      // Busy journal: the stroke is blocked, the ledger still must not act.
      nextClaim = false;
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result).toMatchObject({ kind: "no-op", reason: "condition-not-met" });
      });
      expect(view!.state.doc.toString()).toBe("hello!");
      expect(owner.getHistoryState("shared.ts").undoDepth).toBe(1);

      // No journal entry in this direction: the document ledger proceeds.
      nextClaim = undefined;
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(view!.state.doc.toString()).toBe(initial);
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: false, canRedo: true });
    });

    // ED-AUDIT-008: a history-replay snapshot (journal undo/redo restore) is
    // reconciled as an "undo"-origin transaction — visible to every view, but
    // recorded as no second document-ledger entry, so a follow-up document
    // undo cannot re-apply the change the journal just undid.
    it("ED-AUDIT-008: reconciles a history-replay snapshot without recording a document-ledger entry", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-history-replay" });
      const initial = "class Main {}\n";
      const applied = "import util.Foo;\n\nclass Main {}\n";
      const onChange = vi.fn();
      const props = sharedProps(owner, "primary", initial, onChange, actionHost);
      const rendered = render(<CodeMirrorHost {...props} historyReplay={false} />);
      const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();

      // The apply reaches the ledger as a normal external snapshot.
      rendered.rerender(<CodeMirrorHost {...props} doc={applied} historyReplay={false} />);
      await act(async () => { });
      expect(view!.state.doc.toString()).toBe(applied);
      expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

      // The journal restore replays the pre-apply snapshot with the replay
      // marker: the view reverts, the store-facing onChange stays quiet, and
      // the ledger keeps exactly one (now stale) entry.
      rendered.rerender(<CodeMirrorHost {...props} doc={initial} historyReplay={true} />);
      await act(async () => { });
      expect(view!.state.doc.toString()).toBe(initial);
      expect(owner.getDocument("shared.ts")).toBe(initial);
      expect(owner.getHistoryState("shared.ts").undoDepth).toBe(1);
      expect(owner.undo("shared.ts", "primary")).toBeNull();
      expect(view!.state.doc.toString()).toBe(initial);
    });

    it("ED-AUDIT-002: one undo through the shared owner restores the virtual caret with the text", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-vspace-undo" });
      const initial = "first line\nsecond";
      const rendered = render(
        <CodeMirrorHost
          {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)}
          appearance={{
            fontFamily: "monospace",
            fontSizePx: 14,
            lineHeight: 1.5,
            ligatures: false,
            colorSchemeId: "default",
            highContrast: false,
            virtualSpace: { afterLineEnd: true, atFileBottom: true },
          }}
        />,
      );
      const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();

      // Park a virtual caret past the end of line 0 (offset 10) with 3 columns.
      view!.dispatch({
        selection: EditorSelection.cursor(10),
        effects: setVirtualOverflow.of(new Map([[10, 3]])),
      });
      expect(virtualOverflowAt(view!.state, 10)).toBe(3);

      // Typing consumes the overflow: padding + text in one transaction that
      // reaches the shared owner through the host's update listener.
      expect((virtualSpaceTypingHandler as any).value(view!, 10, 10, "X")).toBe(true);
      expect(view!.state.doc.toString()).toBe("first line   X\nsecond");
      expect(owner.getDocument("shared.ts")).toBe("first line   X\nsecond");

      // The production undo action routes through the shared owner.
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(view!.state.doc.toString()).toBe(initial);
      expect(view!.state.selection.main.head).toBe(10);
      expect(virtualOverflowAt(view!.state, 10)).toBe(3);
      expect(owner.getDocument("shared.ts")).toBe(initial);

      // The restored caret is live: the next insertion re-manufactures padding.
      expect((virtualSpaceTypingHandler as any).value(view!, 10, 10, "Z")).toBe(true);
      expect(view!.state.doc.toString()).toBe("first line   Z\nsecond");
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
        expect(result.kind).toBe("applied");
      });
      expect(view!.state.doc.toString()).toBe(initial);
      expect(virtualOverflowAt(view!.state, 10)).toBe(3);
    });

    it("keeps a native replacement burst ahead of delayed controlled document echoes after undo", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-shared-recovery" });
      const initial = "café\nmatrix";
      const onChange = vi.fn();
      const rendered = render(
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, onChange, actionHost)} />,
      );
      const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();

      view!.dispatch({ changes: { from: initial.length, to: initial.length, insert: "你" } });
      await act(async () => {
        const result = await actionHost.execute("workspace.undo", {
          focus: "editor",
          hasActiveFile: true,
        });
        expect(result.kind).toBe("applied");
      });
      expect(view!.state.doc.toString()).toBe(initial);
      expect(owner.getDocument("shared.ts")).toBe(initial);

      // Save/external synchronization has its own owner revision stream and
      // does not advance the store's controlled documentRevision metadata.
      expect(owner.replaceDocument(
        "shared.ts",
        "save-writer",
        `C${initial.slice(1)}`,
        "external-disk",
      )).not.toBeNull();
      expect(owner.replaceDocument(
        "shared.ts",
        "save-writer",
        initial,
        "external-disk",
      )).not.toBeNull();
      expect(view!.state.doc.toString()).toBe(initial);
      expect(owner.getRevision("shared.ts")).toBe(4);

      // WebDriver contenteditable fill emits character-level document updates.
      // React may render the first controlled echo after the next character has
      // already reached both the live view and the shared transaction owner.
      view!.dispatch({ changes: { from: 0, to: initial.length, insert: "恢" } });
      view!.dispatch({ changes: { from: 1, to: 1, insert: "复" } });
      expect(view!.state.doc.toString()).toBe("恢复");
      expect(owner.getDocument("shared.ts")).toBe("恢复");

      // Model a later native transaction that has reached the shared owner but
      // whose CodeMirror dispatch is still in flight. The delayed "恢" prop is
      // only an acknowledgement and must not synchronously replace the view.
      expect(owner.replaceDocument(
        "shared.ts",
        "primary",
        "恢中",
        "external-disk",
      )).not.toBeNull();
      expect(view!.state.doc.toString()).toBe("恢复");
      expect(owner.getDocument("shared.ts")).toBe("恢中");

      rendered.rerender(
        <CodeMirrorHost
          {...sharedProps(owner, "primary", "恢", onChange, actionHost)}
          documentRevision={3}
        />,
      );
      expect(view!.state.doc.toString()).toBe("恢复");
      expect(owner.getDocument("shared.ts")).toBe("恢中");

      rendered.rerender(
        <CodeMirrorHost
          {...sharedProps(owner, "primary", "恢复", onChange, actionHost)}
          documentRevision={4}
        />,
      );
      expect(view!.state.doc.toString()).toBe("恢复");
      expect(owner.getDocument("shared.ts")).toBe("恢中");
    });

    it("retains canonical text and history after a non-final unmount, then cleans up finally", () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const initial = "hello";
      const rendered = render(
        <div>
          <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
          <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn())} />
        </div>,
      );
      const primary = EditorView.findFromDOM(rendered.container.querySelectorAll<HTMLElement>(".cm-editor")[0]!);
      primary!.dispatch({ changes: { from: 0, to: 0, insert: "say " } });
      expect(owner.getDocument("shared.ts")).toBe("say hello");

      // Unmount only the secondary host; the first lease keeps the document alive.
      rendered.rerender(
        <div>
          <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
        </div>,
      );
      expect(owner.getDocument("shared.ts")).toBe("say hello");
      expect(owner.getHistoryState("shared.ts").canUndo).toBe(true);

      rendered.rerender(
        <div>
          <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
          <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn())} />
        </div>,
      );
      const reopenedViews = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
        .map((element) => EditorView.findFromDOM(element)!);
      expect(reopenedViews).toHaveLength(2);
      expect(reopenedViews[1]!.state.doc.toString()).toBe("say hello");
      expect(owner.getHistoryState("shared.ts").canUndo).toBe(true);

      rendered.unmount();
      expect(owner.getDocument("shared.ts")).toBeNull();
      expect(owner.getHistoryState("shared.ts")).toEqual({
        canUndo: false,
        canRedo: false,
        undoDepth: 0,
        redoDepth: 0,
      });
    });
  });

  describe("ED-SAVE-004 editor recovery decoration synchronization", () => {
    afterEach(() => cleanup());

    it("reconfigures Git markers after a native replacement shortens the document", async () => {
      const initial = "café\nmatrix";
      const secondLineChange: GitLineChange = {
        kind: "modified",
        startLine: 1,
        endLine: 1,
        oldStartLine: 1,
        oldEndLine: 1,
        oldText: "old",
        newText: "matrix",
      };
      const firstLineChange: GitLineChange = {
        ...secondLineChange,
        startLine: 0,
        endLine: 0,
        oldStartLine: 0,
        oldEndLine: 0,
        newText: "c",
      };
      const onChange = vi.fn();
      const rendered = renderEditor(initial, onChange, { gitChanges: [secondLineChange] });
      const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
      const dispatchSpy = vi.spyOn(view!, "dispatch");

      expect(() => {
        view!.dispatch({ changes: { from: 0, to: initial.length, insert: "c" } });
        rendered.rerender(
          <CodeMirrorHost
            {...rendered.props}
            doc="c"
            documentRevision={1}
            gitChanges={[firstLineChange]}
          />,
        );
      }).not.toThrow();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(view!.state.doc.toString()).toBe("c");
      await act(async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      expect(dispatchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(rendered.container.querySelector(".cm-git-change-modified")).toBeTruthy();
    });
  });
}

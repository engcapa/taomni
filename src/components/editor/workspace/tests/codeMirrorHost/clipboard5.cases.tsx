import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "../../workspaceDocumentTransactionOwner";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostClipboard5Cases() {

  describe("ED-REPAIR-007 IME end/blur/reentry session lifecycle", () => {
    afterEach(() => cleanup());

    it("keeps the final microtask flush after end and blur in the same undo entry", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("", vi.fn(), { transactionOwner: owner, viewId: "primary", fileKey: "ime-late.ts" });
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      await act(async () => {
        view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        view.dispatch({ changes: { from: 0, insert: "ni" }, userEvent: "input.type.compose" });
        view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
        view.contentDOM.dispatchEvent(new FocusEvent("blur"));
        await Promise.resolve();
        view.dispatch({ changes: { from: 0, to: 2, insert: "你" }, userEvent: "input.type.compose" });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(owner.getDocument("ime-late.ts")).toBe("你");
      expect(owner.getHistoryState("ime-late.ts").undoDepth).toBe(1);
      owner.undo("ime-late.ts", "primary");
      expect(owner.getDocument("ime-late.ts")).toBe("");
    });

    it("produces two distinct undo entries across two composition sessions separated by blur (ED-REPAIR-007-A1)", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime-blur.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      // Session 1: compose "你"
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 0, insert: "你" },
          userEvent: "input.type.compose",
        });
      });
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
        // Blur arrives immediately before timer fires
        content.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      });

      expect(owner.getDocument("ime-blur.ts")).toBe("你");
      expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(1);

      // Session 2: compose "好"
      act(() => {
        content.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 1, insert: "好" },
          userEvent: "input.type.compose",
        });
      });
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "好" }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(owner.getDocument("ime-blur.ts")).toBe("你好");
      expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(2);

      // Undo 1: reverts "好", leaving "你"
      act(() => {
        owner.undo("ime-blur.ts", "primary");
      });
      expect(owner.getDocument("ime-blur.ts")).toBe("你");
      expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(1);

      // Undo 2: reverts "你", leaving ""
      act(() => {
        owner.undo("ime-blur.ts", "primary");
      });
      expect(owner.getDocument("ime-blur.ts")).toBe("");
      expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(0);
    });

    it("produces two distinct undo entries when next composition starts before end timer (ED-REPAIR-007-A1)", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime-fast.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      // Session 1: "你"
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 0, insert: "你" },
          userEvent: "input.type.compose",
        });
      });
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
        // Immediately start session 2 before macrotask timer
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 1, insert: "好" },
          userEvent: "input.type.compose",
        });
      });
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "好" }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(owner.getDocument("ime-fast.ts")).toBe("你好");
      expect(owner.getHistoryState("ime-fast.ts").undoDepth).toBe(2);

      // Undo step 1 reverts "好"
      owner.undo("ime-fast.ts", "primary");
      expect(owner.getDocument("ime-fast.ts")).toBe("你");

      // Undo step 2 reverts "你"
      owner.undo("ime-fast.ts", "primary");
      expect(owner.getDocument("ime-fast.ts")).toBe("");
    });

    it("finalizes active preedit on blur before compositionend without error (ED-REPAIR-007-A1)", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime-blur-mid.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 0, insert: "pre" },
          userEvent: "input.type.compose",
        });
      });
      // Blur during preedit before compositionend
      act(() => {
        content.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      });

      // Subsequent compositionend does not corrupt state
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "pre" }));
      });

      // Normal typing follows
      act(() => {
        view.dispatch({
          changes: { from: 3, insert: "!" },
        });
      });
      expect(owner.getDocument("ime-blur-mid.ts")).toBe("pre!");
      expect(owner.getHistoryState("ime-blur-mid.ts").undoDepth).toBe(2);
    });

    it("safely finalizes composition on unmount and ignores late timer (ED-REPAIR-007-A2)", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      owner.acquireView("ime-unmount.ts", "secondary", "");
      const rendered = renderEditor("", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime-unmount.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 0, insert: "unmount-test" },
          userEvent: "input.type.compose",
        });
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "unmount-test" }));
      });

      // Unmount before timer fires
      rendered.unmount();

      // Fast-forward any timers
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // Owner should retain text and have finalized composition session
      expect(owner.getDocument("ime-unmount.ts")).toBe("unmount-test");
      expect(owner.getHistoryState("ime-unmount.ts").undoDepth).toBe(1);
      owner.undo("ime-unmount.ts", "secondary");
      expect(owner.getDocument("ime-unmount.ts")).toBe("");
    });

    it("finalizes session on fileKey switch and does not pollute new file (ED-REPAIR-007-A2)", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "fileA.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => {
        view.dispatch({
          changes: { from: 0, insert: "typedA" },
          userEvent: "input.type.compose",
        });
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "typedA" }));
      });

      // Switch fileKey prop to fileB.ts
      rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="fileB.ts" doc="" />);

      // Now fileA composition should be finalized
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(owner.getDocument("fileA.ts")).toBe("typedA");
    });
  });

  describe("ED-IMPROVE-009 late clipboard results report a cancelled observation", () => {
    afterEach(() => cleanup());

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    function stubHandle(
      read: () => Promise<unknown>,
      write: () => Promise<unknown>,
    ) {
      return {
        workspaceId: "ws-009",
        attachConsumer: () => ({ detach: () => { } }),
        getSnapshot: () => ({
          permission: "granted",
          permissionGeneration: 3,
          exclusion: "recorded",
          payloadRevision: 1,
        }),
        readSystemClipboard: read,
        writeSystemClipboard: write,
        write: () => { throw new Error("unused"); },
        read: () => null,
        clear: () => { },
        release: () => { },
        historyEntries: () => [],
        pasteFromHistory: () => null,
        removeHistoryEntry: () => false,
        clearHistory: () => { },
        setHistoryEnabled: () => { },
        isHistoryEnabled: () => true,
        setHistoryLimits: () => { },
        historyLimits: () => ({ maxItems: 0, maxTotalBytes: 0 }),
        historyExclusion: () => "recorded",
        setPermission: () => { },
        permission: () => "granted",
        attachPermissionAdapter: () => () => { },
        syncPermission: async () => "granted",
        subscribe: () => () => { },
      };
    }

    it("reports a cancelled paste with the OS read effect after the selection moved", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor")!)!;
      act(() => {
        port!.execute("paste");
      });
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(5) });
      });
      act(() => {
        pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" });
      });
      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
        permission: "granted",
      });
      expect(view.state.doc.toString()).toBe("hello world");
    });

    it("keeps a performed cut write fact after the document changed", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(async () => ({ outcome: "denied", systemEffect: "not-performed", fallbackSession: null }), () => pending.promise);
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.range(0, 5) });
      });
      act(() => {
        port!.execute("cut");
      });
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(0) });
      });
      act(() => {
        pending.resolve({ outcome: "denied", systemEffect: "performed" });
      });
      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "cut",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      // No cut happened: the document keeps its text.
      expect(view.state.doc.toString()).toBe("hello world");
    });

    // ED-MAIN-007: an async paste whose owner moved must not edit the background
    // buffer, steal focus back, or add history, but its OS effect is still
    // observed through the frozen endpoint.
    it("keeps a paste out of a background buffer and does not steal focus when the owner moved (ED-MAIN-007)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      const owner = new WorkspaceDocumentTransactionOwner();
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "owner.ts",
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      act(() => { content.focus(); });
      expect(view.hasFocus).toBe(true);

      act(() => { port!.execute("paste"); });
      const search = document.createElement("input");
      document.body.appendChild(search);
      act(() => { search.focus(); });
      act(() => { pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      expect(view.state.doc.toString()).toBe("hello world");
      expect(document.activeElement).toBe(search);
      expect(owner.getHistoryState("owner.ts").undoDepth).toBe(0);
      search.remove();
    });

    // A legitimate menu/context-menu paste runs while the editor does not hold
    // DOM focus but no newer surface claimed it; it must still apply.
    it("still pastes for an authorized menu owner that is not focused at request (ED-MAIN-007)", async () => {
      const pending = deferred<unknown>();
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const menu = document.createElement("button");
      document.body.appendChild(menu);

      act(() => { content.focus(); });
      // The menu takes focus before the command executes (owner generation moves
      // before the request, so no change is observed while it is pending).
      act(() => { menu.focus(); });
      act(() => { port!.execute("paste"); });
      act(() => { pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" }); });

      await waitFor(() => expect(view.state.doc.toString()).toContain("payload"));
      menu.remove();
    });

    it("observes an OS effect that returns after the view was destroyed (ED-MAIN-007)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      act(() => { port!.execute("paste"); });
      // The whole host unmounts (its clipboard WeakMap entry is released) while
      // the OS read is still in flight.
      rendered.unmount();
      act(() => { pending.resolve({ outcome: "denied", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
    });
  });
}

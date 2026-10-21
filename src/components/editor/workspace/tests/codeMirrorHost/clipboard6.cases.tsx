import { closeSearchPanel, openSearchPanel } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "../../workspaceDocumentTransactionOwner";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostClipboard6Cases() {

  describe("ED-REPAIR-008 irreversible clipboard owner loss and multi-split isolation", () => {
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
        workspaceId: "ws-008",
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

    it("rejects pending paste when focus moves from editor to search box and back to editor (editor -> search -> editor) (ED-REPAIR-008-A1)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      const owner = new WorkspaceDocumentTransactionOwner();
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "search-focus.ts",
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      act(() => { content.focus(); });
      expect(view.hasFocus).toBe(true);

      act(() => { port!.execute("paste"); });

      // Real production Find panel must irreversibly revoke the pending owner.
      act(() => { openSearchPanel(view); });
      const search = view.dom.querySelector<HTMLInputElement>('input[name="search"]')!;
      await waitFor(() => expect(search).toHaveFocus());

      // Focus returns back to the editor before the promise settles
      act(() => { closeSearchPanel(view); content.focus(); });
      expect(view.hasFocus).toBe(true);

      // Pending read settles
      act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      // Document must be unchanged, undo depth must be 0
      expect(view.state.doc.toString()).toBe("hello world");
      expect(owner.getHistoryState("search-focus.ts").undoDepth).toBe(0);
    });

    it("rejects pending paste when active leaf moves to another group and returns (leaf A -> B -> A) (ED-REPAIR-008-A1)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        active: true,
        visible: true,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      act(() => { port!.execute("paste"); });

      // Group switches away from leaf A (active -> false)
      rendered.rerender(<CodeMirrorHost {...rendered.props} active={false} visible={true} />);

      // Group switches back to leaf A (active -> true)
      rendered.rerender(<CodeMirrorHost {...rendered.props} active={true} visible={true} />);

      // Pending read settles
      act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      expect(view.state.doc.toString()).toBe("hello world");
    });

    it("rejects pending paste when workspace visibility toggles off and on (workspace A -> B -> A) (ED-REPAIR-008-A1)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        visible: true,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      act(() => { port!.execute("paste"); });

      // Workspace hidden
      rendered.rerender(<CodeMirrorHost {...rendered.props} visible={false} />);

      // Workspace shown again
      rendered.rerender(<CodeMirrorHost {...rendered.props} visible={true} />);

      // Pending read settles
      act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      expect(view.state.doc.toString()).toBe("hello world");
    });

    it("rejects older paste when a newer paste request was initiated (ED-REPAIR-008-A1)", async () => {
      const pending1 = deferred<unknown>();
      const pending2 = deferred<unknown>();
      let readCallCount = 0;
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(
        () => {
          readCallCount++;
          return readCallCount === 1 ? pending1.promise : pending2.promise;
        },
        async () => ({ outcome: "success", systemEffect: "performed" }),
      );
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.range(0, 11) });
      });

      // Trigger first paste
      act(() => { port!.execute("paste"); });

      // Trigger second paste
      act(() => { port!.execute("paste"); });

      // Second paste settles first and applies
      act(() => { pending2.resolve({ outcome: "success", text: "new-text", systemEffect: "performed" }); });
      await waitFor(() => expect(view.state.doc.toString()).toBe("new-text"));

      // First paste settles later and must be cancelled
      act(() => { pending1.resolve({ outcome: "success", text: "old-text", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(2));
      const cancelled = observations.find((o) => (o as { outcome: string; }).outcome === "cancelled");
      expect(cancelled).toBeDefined();
      // Document must keep new-text, not old-text
      expect(view.state.doc.toString()).toBe("new-text");
    });

    it("cancels pending menu paste when focus moves to search box before settle (menu -> search) (ED-REPAIR-008-A2)", async () => {
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
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

      // Menu button has focus at request
      const menu = document.createElement("button");
      menu.setAttribute("role", "menuitem");
      document.body.appendChild(menu);
      act(() => { menu.focus(); });

      act(() => { port!.execute("paste"); });

      // Focus moves to search input instead of editor
      const search = document.createElement("input");
      document.body.appendChild(search);
      act(() => { search.focus(); });

      act(() => { pending.resolve({ outcome: "success", text: "menu-payload", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      expect(view.state.doc.toString()).toBe("hello world");
      menu.remove();
      search.remove();
    });

    it("cancels in-flight copy when owner is lost and reports cancelled observation with systemEffect (ED-REPAIR-008-A2)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(async () => ({ outcome: "success" }), () => pending.promise);
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      act(() => { content.focus(); });

      act(() => {
        view.dispatch({ selection: EditorSelection.range(0, 5) });
      });

      act(() => { port!.execute("copy"); });

      // Focus leaves editor
      const search = document.createElement("input");
      document.body.appendChild(search);
      act(() => { search.focus(); });

      // Write finishes with performed
      act(() => { pending.resolve({ outcome: "success", systemEffect: "performed" }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "copy",
        outcome: "cancelled",
        systemEffect: "performed",
      });
      search.remove();
    });

    it("does not invoke onUnavailable on unmounted or inactive host when late denied result arrives (ED-REPAIR-008-A2)", async () => {
      const pending = deferred<unknown>();
      const observations: unknown[] = [];
      const unavailableMessages: string[] = [];
      let port: { execute: (id: string, options?: unknown) => boolean; } | null = null;
      const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
      const rendered = renderEditor("hello world", vi.fn(), {
        clipboardHandle: handle as never,
        onClipboardUnavailable: (msg) => { unavailableMessages.push(msg); },
        onClipboardObservation: (record) => { observations.push(record); },
        onCommandPortChange: (registration) => { port = registration.port as never; },
      });
      await waitFor(() => expect(port).not.toBeNull());
      act(() => { port!.execute("paste"); });

      // Host is unmounted
      rendered.unmount();

      // Late denial arrives
      act(() => { pending.resolve({ outcome: "denied", systemEffect: "not-performed", fallbackSession: null }); });

      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({
        operation: "paste",
        outcome: "cancelled",
        systemEffect: "not-performed",
      });
      // onUnavailable should NOT have been called on unmounted host
      expect(unavailableMessages).toHaveLength(0);
    });
  });
}

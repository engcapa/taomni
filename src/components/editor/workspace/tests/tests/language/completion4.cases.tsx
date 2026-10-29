import { findEditorByTitle } from "../../editorReadiness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LspDocumentStatus } from "../../../../../../lib/editor/lsp";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { type registerLanguageCasesFixture } from "../../language.cases";

export interface registerlanguageCompletion4CasesContext {
  workspaceTestHarness: registerLanguageCasesFixture;
}

export function registerlanguageCompletion4Cases(caseContext: registerlanguageCompletion4CasesContext) {
  describe("P0-J1 completion identity host containment", () => {
    it("lets the completion popup own Arrow keys and Tab in the workspace capture phase", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-keyboard",
        workspaceInstanceId: "instance-completion-keyboard",
        name: "Completion Keyboard",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/App.java", "sout"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/App.java");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        startCompletion(view!);
      });
      await waitFor(() => {
        const element = document.querySelector(".cm-tooltip-autocomplete");
        expect(element).not.toBeNull();
        return element!;
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const selectedId = () => content!.getAttribute("aria-activedescendant");
      const before = selectedId();

      fireEvent.keyDown(content!, { key: "ArrowDown", code: "ArrowDown" });
      await waitFor(() => expect(selectedId()).not.toBe(before));
      fireEvent.keyDown(content!, { key: "Tab", code: "Tab" });

      await waitFor(() => expect(view!.state.doc.toString()).toContain("System.out"));
      expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
    });

    it("never renders inactive-provider completion candidates in a mounted editor", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      caseContext.workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: {
          path: "src/main.ts",
          uri: "file:///repo/app/src/main.ts",
          presetId: null,
          languageId: "typescript",
          displayName: "TypeScript",
          available: true,
          active: false,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        } satisfies LspDocumentStatus,
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-inactive",
        workspaceInstanceId: "instance-completion-inactive",
        name: "Completion Inactive",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "valu" },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
        startCompletion(view!);
      });

      // Give the deferred provider response (inactive + stale items) time to
      // settle; whatever the popup shows, stale provider labels must not be
      // among the options.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const optionEls = rendered.container.querySelectorAll(".cm-tooltip-autocomplete li, .cm-completionLabel");
      for (const optionEl of optionEls) {
        expect(optionEl.textContent).not.toContain("StaleServerCandidate");
      }
    });

    it.each([false, true])("keeps a post-save member completion pending until the live document sync finishes (edit while waiting: %s)", async (editWhileWaiting) => {
      const { EditorView } = await import("@codemirror/view");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-completion-delayed-sync-${editWhileWaiting}`,
        workspaceInstanceId: `instance-completion-delayed-sync-${editWhileWaiting}`,
        name: "Completion Delayed Sync",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/App.java", "System.out.println();"));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(
        "src/App.java", "System.out.println();\n", { hash: "hash-delayed-sync" },
      )));
      const javaStatus = caseContext.workspaceTestHarness.documentStatus({
        path: "src/App.java", uri: "file:///repo/app/src/App.java", presetId: "jdtls",
        languageId: "java", displayName: "Java", available: true, active: true,
        capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ completion: true, completionTriggerCharacters: ["."] }),
      });
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(javaStatus);
      caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(javaStatus);
      caseContext.workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: javaStatus, isIncomplete: false,
        items: [{
          label: "println", kind: 2, detail: null, documentation: null,
          insertText: "println", insertTextFormat: 1, filterText: null, sortText: null,
          textEdit: null, additionalTextEdits: [], raw: {},
        }],
      });
      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/App.java");
      await waitFor(() => expect(rendered.container.querySelector(".cm-content")).not.toBeNull());
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "\n" },
          selection: { anchor: view.state.doc.length + 1 }, userEvent: "input.type",
        });
      });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "true"));
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "false"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

      let acknowledgeSync!: () => void;
      const pendingSync = new Promise<typeof javaStatus>((resolve) => {
        acknowledgeSync = () => resolve(javaStatus);
      });
      caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockClear();
      caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockImplementation(() => pendingSync);
      caseContext.workspaceTestHarness.lspMocks.lspCompletion.mockClear();
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "System.out." },
          selection: { anchor: 11 }, userEvent: "input.type",
        });
      });
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspChangeDocument).toHaveBeenCalled());
      // The provider is active, but its real document acknowledgment can be
      // slower than the feature's 400ms best-effort wait. It must receive no
      // query for stale text, and the final dot must not require another key.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
      expect(caseContext.workspaceTestHarness.lspMocks.lspCompletion).not.toHaveBeenCalled();
      if (editWhileWaiting) {
        act(() => view.dispatch({
          changes: { from: 11, insert: "p" }, selection: { anchor: 12 }, userEvent: "input.type",
        }));
      }
      await act(async () => { acknowledgeSync(); });
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCompletion).toHaveBeenCalledWith(
        expect.anything(), { line: 0, character: editWhileWaiting ? 12 : 11 },
        editWhileWaiting ? null : ".", expect.anything(),
      ));
      expect(caseContext.workspaceTestHarness.lspMocks.lspCompletion.mock.calls.every((call) => call[1].character === (editWhileWaiting ? 12 : 11))).toBe(true);
      await waitFor(() => expect(document.querySelector("li.cm-completion-type-method")).toHaveTextContent("println"));
      expect(caseContext.workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    });

    it("never notifies jdtls with didSave and completes on the fast path after saving", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-after-save",
        workspaceInstanceId: "instance-completion-after-save",
        name: "Completion After Save",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/App.java", "System."));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(
        "src/App.java",
        "System.out.",
        { hash: "hash-system" },
      )));

      const javaStatus = caseContext.workspaceTestHarness.documentStatus({
        path: "src/App.java",
        uri: "file:///repo/app/src/App.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Java",
        available: true,
        active: true,
      });
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(javaStatus);
      caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(javaStatus);

      caseContext.workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: javaStatus,
        isIncomplete: false,
        items: [{
          label: "out",
          kind: 7,
          detail: "PrintStream",
          documentation: null,
          insertText: "out",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/App.java");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();

      // First completion before save
      act(() => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        startCompletion(view!);
      });
      await waitFor(() => {
        expect(caseContext.workspaceTestHarness.lspMocks.lspCompletion).toHaveBeenCalled();
      });

      // Make document dirty and save via Ctrl+S
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "out." },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "true"));

      const changesAtSave = caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length;
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() =>
        expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "false"),
      );
      // Eclipse JDT LS degrades completions after didSave and can answer the
      // first post-save query from the pre-edit document. The save flow's
      // workspace/didChangeWatchedFiles notification owns the provider rebuild,
      // so didSave must never be sent and no recovery didChange is needed.
      expect(caseContext.workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();
      const changesAfterRecovery = caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length;

      // Trigger completion after saving without typing any new characters:
      // the buffer is already synced, so completion must reach lspCompletion
      // directly (fast path) without another didChange round trip.
      act(() => {
        startCompletion(view!);
      });

      await waitFor(() => {
        expect(caseContext.workspaceTestHarness.lspMocks.lspCompletion.mock.calls.length).toBeGreaterThan(1);
      });
      expect(caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length).toBe(changesAfterRecovery);
      expect(caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length).toBeGreaterThanOrEqual(changesAtSave);
    });
  });
}

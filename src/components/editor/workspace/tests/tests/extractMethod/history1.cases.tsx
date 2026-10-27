import type { ExtractFixture, ExtractMode } from "./model";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";



export interface registerextractMethodHistory1CasesContext {
    setupExtract: (instanceId: string, mode?: "none" | "timeout" | "normal" | "multi" | "multi-mixed" | "disabled" | "command-only" | "malformed" | "changed" | "boom" | "resolve-error" | "symbols-error" | "symbols-ambiguous" | "rename-error" | "multi-file" | "rename-multi-file") => ExtractFixture;
    EXTRACT_INSTANCE: string;
    mountExtract: (fixture: ExtractFixture) => Promise<{ pane: HTMLElement; content: HTMLElement; }>;
    selectExtractRange: (content: HTMLElement) => EditorView;
    pressExtractChord: (pane: HTMLElement) => void;
    workspaceTestHarness: registerWorkspaceEditsCasesFixture;
    B1: string;
    EXTRACT_PATH: string;
    B2: string;
    EXTRACT_ABS: string;
    B0: string;
    HELPER_PATH: string;
}

export function registerextractMethodHistory1Cases(caseContext: registerextractMethodHistory1CasesContext) {

    it("Ctrl+Alt+M runs the only method candidate without a menu and prompts for a name", async () => {
      const fixture = caseContext.setupExtract(caseContext.EXTRACT_INSTANCE);
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled());
      // DEC-02: the method candidate is applied directly; no frozen menu appears.
      expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
      // Only the method candidate was resolved (the variable candidate is filtered out).
      expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);

      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(screen.getByTestId("text-input-dialog")).toHaveTextContent("Extract Method");
      expect(input).toHaveValue("extracted");
      expect((input as HTMLInputElement).selectionStart).toBe(0);
      expect((input as HTMLInputElement).selectionEnd).toBe("extracted".length);

      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      await waitFor(() => expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B1));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));
      expect(screen.queryByTestId("code-workspace-intention-extract")).not.toBeInTheDocument();
    });

    it("Enter renames call site and declaration; Escape keeps the default name", async () => {
      const fixture = caseContext.setupExtract("instance-extract-enter");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));

      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B2));
      expect(fixture.text()).toContain("int sumOf(int[] values)");
      expect(fixture.text()).toContain("int sum = sumOf(values);");
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledWith(expect.anything(), expect.anything(), "sumOf");
      await waitFor(() => expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B2));
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      // DEC-03: the naming step hands the caret back on the call-statement line.
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(
        view.state.doc.lineAt(view.state.selection.main.head).text,
      ).toBe("        int sum = sumOf(values);"));

      // Fresh setup: the watcher echo of the extract's own save, delivered while
      // the naming prompt is open, is not a workspace change (no stale cancel).
      await cleanup();
      caseContext.workspaceTestHarness.runtimeState.tauri = true;
      const echoed = caseContext.setupExtract("instance-extract-echo");
      const echo = await caseContext.mountExtract(echoed);
      caseContext.selectExtractRange(echo.content);
      caseContext.pressExtractChord(echo.pane);
      const echoInput = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(echoed.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B1));
      await act(async () => {
        await emit("lsp://external-file-change", { workspaceId: "instance-extract-echo", path: caseContext.EXTRACT_ABS, type: 2 });
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      fireEvent.change(echoInput, { target: { value: "sumOf" } });
      fireEvent.keyDown(echoInput, { key: "Enter" });
      await waitFor(() => expect(echoed.text()).toBe(caseContext.B2));
      expect(useAppStore.getState().statusMessage).not.toContain("workspace changed");
      caseContext.workspaceTestHarness.runtimeState.tauri = false;

      // Fresh setup: Escape keeps the provider default name and adds no history.
      await cleanup();
      const escaped = caseContext.setupExtract("instance-extract-escape");
      const second = await caseContext.mountExtract(escaped);
      caseContext.selectExtractRange(second.content);
      caseContext.pressExtractChord(second.pane);
      const escapeInput = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(escaped.text()).toBe(caseContext.B1));
      const renamesBeforeEscape = caseContext.workspaceTestHarness.lspMocks.lspRename.mock.calls.length;
      fireEvent.keyDown(escapeInput, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());
      expect(escaped.text()).toBe(caseContext.B1);
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename.mock.calls.length).toBe(renamesBeforeEscape);
    });

    it("renames the extracted method while provider indexing remains active", async () => {
      caseContext.workspaceTestHarness.runtimeState.tauri = true;
      const fixture = caseContext.setupExtract("instance-extract-progress");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B1));
      await act(async () => {
        await emit("lsp://work-done-progress", {
          workspaceId: "instance-extract-progress",
          presetId: "app",
          serverLabel: "jdt.ls",
          rootUri: "file:///repo/app",
          token: "extract-indexing",
          kind: "begin",
          title: "Building",
          message: null,
          percentage: null,
          cancellable: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B2));
      expect(fixture.text()).toBe(caseContext.B2);
      expect(useAppStore.getState().statusMessage).not.toContain("stale");
      caseContext.workspaceTestHarness.runtimeState.tauri = false;
    });

    it("two editor undos and redos restore each transaction", async () => {
      const fixture = caseContext.setupExtract("instance-extract-undo");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B2));

      content.focus();
      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
      expect(useAppStore.getState().statusMessage).toContain("Undid Rename symbol");

      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B0));
      expect(useAppStore.getState().statusMessage).toContain("Undid");

      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B2));
    });

    it("multiple method candidates support keyboard and pointer selection", async () => {
      const fixture = caseContext.setupExtract("instance-extract-multi", "multi");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      const menu = await screen.findByTestId("context-menu");
      expect(menu).toBeInTheDocument();
      const candidates = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[data-testid^="code-workspace-intention-"]'),
      );
      const labels = candidates.map((item) => item.textContent ?? "");
      expect(candidates).toHaveLength(3);
      expect(labels.some((label) => label.includes("Extract to method"))).toBe(true);
      const disabledItem = candidates.find((item) => (item.textContent ?? "").includes("unavailable"));
      expect(disabledItem).toBeDefined();
      expect(disabledItem).toBeDisabled();
      // The variable candidate never enters the Extract Method menu.
      expect(screen.queryByText("Extract to local variable")).not.toBeInTheDocument();

      // Pointer selection runs the first enabled method candidate.
      const enabled = candidates.filter((item) => !item.disabled);
      expect(enabled.length).toBeGreaterThan(0);
      fireEvent.click(enabled[0]!);
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalled());
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      expect(input).toHaveValue("extracted");
    });

    it("empty selection follows actual method availability", async () => {
      const available = caseContext.setupExtract("instance-extract-empty-ok");
      const first = await caseContext.mountExtract(available);
      const view = EditorView.findFromDOM(first.content)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(5).from) });
      });
      first.content.focus();
      caseContext.pressExtractChord(first.pane);
      // The provider still offers a method extraction for the caret statement.
      await waitFor(() => expect(available.text()).toBe(caseContext.B1));
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(input).toHaveValue("extracted");
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());

      await cleanup();
      const none = caseContext.setupExtract("instance-extract-empty-none", "none");
      const second = await caseContext.mountExtract(none);
      const secondView = EditorView.findFromDOM(second.content)!;
      act(() => {
        secondView.dispatch({ selection: EditorSelection.cursor(secondView.state.doc.line(5).from) });
      });
      second.content.focus();
      caseContext.pressExtractChord(second.pane);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
        "Extract Method: select the statements or expression to extract",
      ));
      expect(none.text()).toBe(caseContext.B0);
      expect(none.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B0);
      // Only the earlier empty-selection success resolved a candidate; the
      // zero-candidate boundary path resolves nothing.
      expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);
    });

    it.each<{ mode: ExtractMode; expect: string }>([
      { mode: "timeout", expect: "Code action request timed out before the provider answered; try again" },
      { mode: "changed", expect: "Refactor actions were cancelled because the document changed; try again" },
      { mode: "boom", expect: "B-007 controlled provider error" },
      { mode: "resolve-error", expect: "Code action resolve failed" },
      { mode: "malformed", expect: "malformed" },
      { mode: "command-only", expect: "Code action rejected" },
      { mode: "disabled", expect: "The selected block has several outputs" },
      { mode: "none", expect: "Extract Method is not available for this selection" },
    ])("provider $mode remains distinct from empty actions", async (entryCase) => {
      const fixture = caseContext.setupExtract("instance-extract-" + entryCase.mode, entryCase.mode);
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(entryCase.expect));
      expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B0);
      expect(fixture.text()).toBe(caseContext.B0);
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
    });

    it("dirty buffer extracts without saving or prompting", async () => {
      const fixture = caseContext.setupExtract("instance-extract-dirty");
      const { pane, content } = await caseContext.mountExtract(fixture);
      const view = EditorView.findFromDOM(content)!;
      act(() => {
        view.dispatch({ changes: { from: 0, to: 0, insert: "// pending\n" } });
      });
      await waitFor(() => expect(fixture.text()).toContain("// pending"));
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      await waitFor(() => expect(fixture.text()).toContain("extracted(values)"));
      expect(fixture.text()).toContain("// pending");
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B0);
      expect(useAppStore.getState().statusMessage).toContain("save the file, then press Shift+F6");
    });

    it("ambiguous or failed symbol snapshots preserve the extraction", async () => {
      for (const mode of ["symbols-error", "symbols-ambiguous"] as ExtractMode[]) {
        const fixture = caseContext.setupExtract("instance-extract-" + mode, mode);
        const { pane, content } = await caseContext.mountExtract(fixture);
        caseContext.selectExtractRange(content);
        caseContext.pressExtractChord(pane);
        // DEC-03 re-reads a damaged outline once, so the naming chain settles
        // after two provider samples per side.
        await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
          "Extracted method; could not locate the new method to rename it",
        ), { timeout: 6000 });
        expect(fixture.text()).toBe(caseContext.B1);
        expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
        expect(caseContext.workspaceTestHarness.lspMocks.lspRename).not.toHaveBeenCalled();
        await cleanup();
      }
    });

    it("name input validates and retries without repeating extraction", async () => {
      const fixture = caseContext.setupExtract("instance-extract-retry");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      fireEvent.change(input, { target: { value: "1bad" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // The provider rejects the name; the prompt reopens with the user's input
      // and the committed extraction is never repeated.
      await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspRename)
        .toHaveBeenCalledWith(expect.anything(), expect.anything(), "1bad"));
      await waitFor(() => expect(useAppStore.getState().statusMessage)
        .toContain("'1bad' is not a valid identifier"));
      const retry = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(retry).toHaveValue("1bad");
      expect(fixture.text()).toBe(caseContext.B1);
      expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1);
      fireEvent.change(retry, { target: { value: "sumOf" } });
      fireEvent.keyDown(retry, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B2));
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(2);
    });

    it("late responses cannot reopen naming or rename another document", async () => {
      const fixture = caseContext.setupExtract("instance-extract-late");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);

      // Hold the symbols-after sample, edit the committed buffer, then release:
      // the naming chain must not prompt or write for the stale receipt.
      let releaseSymbols: (() => void) | null = null;
      const originalSymbols = caseContext.workspaceTestHarness.lspMocks.lspDocumentSymbols.getMockImplementation()!;
      caseContext.workspaceTestHarness.lspMocks.lspDocumentSymbols.mockImplementation(async (descriptor: unknown) => {
        const result = await originalSymbols(descriptor);
        // Hold only the post-extraction sample, whichever call reaches it.
        if (!releaseSymbols && fixture.text().includes("extracted(values)")) {
          await new Promise<void>((resolve) => { releaseSymbols = resolve; });
        }
        return result;
      });

      caseContext.pressExtractChord(pane);
      await waitFor(() => expect(releaseSymbols).not.toBeNull());
      const view = EditorView.findFromDOM(content)!;
      act(() => {
        view.dispatch({ changes: { from: 0, to: 0, insert: "// external\n" } });
      });
      await waitFor(() => expect(fixture.text()).toContain("// external"));
      releaseSymbols!();
      await waitFor(() => expect(fixture.text()).toContain("extracted(values)"));
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename).not.toHaveBeenCalled();
    });
    it("Escape in the retry prompt cancels the naming step without replaying the rejected name", async () => {
      // Regression: a dismissed retry prompt is not a provider empty edit. Before
      // the fix the loop replayed the previously entered name and renamed both
      // the declaration and the call site without any user confirmation.
      const fixture = caseContext.setupExtract("instance-extract-cancel-retry", "rename-error");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));

      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      const retry = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(retry).toHaveValue("sumOf");
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(retry, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());
      // Wait past the empty-edit replay delay: nothing may run on its own.
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, 1600); });
      });
      expect(caseContext.workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(fixture.text()).toBe(caseContext.B1);
      expect(fixture.text()).toContain("int sum = extracted(values);");
      expect(fixture.disk[caseContext.EXTRACT_PATH]).toBe(caseContext.B1);
    });

    it("extract preview keeps the declaration and call site as required edits", async () => {
      // Regression: the multi-file extraction preview offered every operation as
      // excludable, so Deselect All could commit a broken partial extraction.
      const fixture = caseContext.setupExtract("instance-extract-preview-required", "multi-file");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      const dialog = await screen.findByTestId("refactoring-preview-dialog");
      const usageInputs = () => Array.from(
        dialog.querySelectorAll<HTMLInputElement>('[data-testid^="refactoring-preview-usage-"]'),
      );
      const usages = usageInputs();
      expect(usages.length).toBeGreaterThan(1);
      expect(usages.every((usage) => usage.disabled)).toBe(true);
      expect(usages.every((usage) => usage.checked)).toBe(true);

      const applyButton = within(dialog).getByTestId("refactoring-preview-apply");
      const labelBefore = applyButton.textContent;
      fireEvent.click(within(dialog).getByTestId("refactoring-preview-select-none"));
      await waitFor(() => expect(usageInputs().every((usage) => usage.checked)).toBe(true));
      expect(usageInputs().length).toBe(usages.length);
      expect(applyButton.textContent).toBe(labelBefore);
      expect(applyButton.textContent).not.toBe("Do Refactor (0)");

      fireEvent.click(applyButton);
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      expect(fixture.text()).toContain("int sum = extracted(values);");
      expect(fixture.text()).toContain("private static int extracted(int[] values) {");
      expect(fixture.disk[caseContext.HELPER_PATH]).toContain("// extract-cross-file");
    });

    it("a stale rename names the invalidation that cancelled it", async () => {
      // "the workspace changed" alone cannot separate a real concurrent edit
      // from a watcher echo, so the status must carry reason, path and revisions.
      // The watcher listener is registered at mount, so the Tauri runtime must be
      // on before the workspace renders for an external change to arrive.
      caseContext.workspaceTestHarness.runtimeState.tauri = true;
      const fixture = caseContext.setupExtract("instance-rename-stale-detail");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));

      // Change an unrelated file on disk while the naming prompt is open: a real
      // content change, so the confirmed rename must be refused with detail.
      // The watcher event only reaches the tab in the Tauri runtime.
      await act(async () => {
        await emit("lsp://external-file-change", {
          workspaceId: "instance-rename-stale-detail",
          path: "/repo/app/src/main/java/demo/Unrelated.java",
          type: 2,
        });
        await new Promise((resolve) => { window.setTimeout(resolve, 200); });
      });
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        const message = useAppStore.getState().statusMessage ?? "";
        expect(message).toContain("workspace changed");
      });
      const message = useAppStore.getState().statusMessage!;
      expect(message).toMatch(/reasons=[a-z-]+/);
      expect(message).toContain("Unrelated.java");
      expect(message).toMatch(/revision=\d+\/\d+/);
      expect(fixture.text()).not.toContain("sumOf");
      caseContext.workspaceTestHarness.runtimeState.tauri = false;
    });

    it("a view switch while the rename preview is open never renames the abandoned file", async () => {
      // DEC-07: the owner guard runs again at the preflight and at the exact
      // mutation boundary, so an async preview cannot commit a rename for a
      // document the user has left.
      const fixture = caseContext.setupExtract("instance-extract-owner-guard", "rename-multi-file");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const dialog = await screen.findByTestId("refactoring-preview-dialog");
      // Switch the active view while the rename is paused on the preview.
      fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right"));
      await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane").length).toBeGreaterThan(1));

      fireEvent.click(within(dialog).getByTestId("refactoring-preview-apply"));
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, 300); });
      });
      expect(fixture.text()).not.toContain("sumOf");
      expect(fixture.disk[caseContext.EXTRACT_PATH]).not.toContain("sumOf");
      expect(fixture.disk[caseContext.HELPER_PATH]).not.toContain("// rename-cross-file");
    });

    it("the Extract Method menu lists only method candidates", async () => {
      // DEC-02: two method candidates plus variable/constant proposals must not
      // widen the menu, and no second provider request may run for it.
      const fixture = caseContext.setupExtract("instance-extract-mixed-menu", "multi-mixed");
      const { pane, content } = await caseContext.mountExtract(fixture);
      caseContext.selectExtractRange(content);
      caseContext.pressExtractChord(pane);

      const menu = await screen.findByTestId("context-menu");
      const candidates = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[data-testid^="code-workspace-intention-"]'),
      );
      expect(candidates).toHaveLength(2);
      expect(candidates.every((item) => (item.textContent ?? "").includes("Extract to method"))).toBe(true);
      expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1);
      expect(within(menu).queryByText("Extract to local variable")).not.toBeInTheDocument();
      expect(within(menu).queryByText(/Extract to constant/)).not.toBeInTheDocument();

      fireEvent.click(candidates[0]!);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(caseContext.B1));
      expect(input).toHaveValue("extracted");
    });
}

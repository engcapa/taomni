import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspDocumentSymbol } from "../../../../lib/editor/lsp";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "./workspaceEdits.cases";

export function registerExtractMethodCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
describe("ED-PARITY-007: extract method direct run, naming and boundaries (mounted)", () => {
    const EXTRACT_PATH = "src/main/java/demo/ExtractTarget.java";
    const EXTRACT_KEY = "root:app:" + EXTRACT_PATH;
    const EXTRACT_ABS = "/repo/app/" + EXTRACT_PATH;
    const EXTRACT_URI = "file://" + EXTRACT_ABS;
    const HELPER_PATH = "src/main/java/demo/ExtractHelper.java";
    const HELPER_ABS = "/repo/app/" + HELPER_PATH;
    const HELPER_URI = "file://" + HELPER_ABS;
    const EXTRACT_TITLE = "app / " + EXTRACT_PATH;
    const EXTRACT_INSTANCE = "instance-extract-007";
    const B0 = [
      "package demo;",
      "",
      "public class ExtractTarget {",
      "    int total(int[] values) {",
      "        int sum = 0;",
      "        for (int v : values) {",
      "            sum += v;",
      "        }",
      "        return sum * 2;",
      "    }",
      "",
      "    String range(int[] values) {",
      "        return null;",
      "    }",
      "}",
      "",
    ].join("\n");
    const B1 = B0
      .replace(
        "        int sum = 0;\n        for (int v : values) {\n            sum += v;\n        }\n",
        "        int sum = extracted(values);\n",
      )
      .replace(
        "    }\n\n    String range",
        "    }\n\n    private static int extracted(int[] values) {\n        int sum = 0;\n        for (int v : values) {\n            sum += v;\n        }\n        return sum;\n    }\n\n    String range",
      );
    const B2 = B1.split("extracted").join("sumOf");

    type ExtractMode =
      | "normal" | "multi" | "multi-mixed" | "none" | "disabled" | "command-only" | "malformed"
      | "timeout" | "changed" | "boom" | "resolve-error" | "symbols-error"
      | "symbols-ambiguous" | "rename-error" | "multi-file" | "rename-multi-file";

    function extractMethodAction(title: string, disabled?: string) {
      const raw: Record<string, unknown> = { title, kind: "refactor.extract.function", data: { parity007: title } };
      if (disabled) raw.disabled = { reason: disabled };
      return {
        title,
        kind: "refactor.extract.function",
        isPreferred: !disabled,
        edit: null,
        command: null,
        commandArguments: null,
        raw,
      };
    }

    function extractVariableAction() {
      return {
        title: "Extract to local variable",
        kind: "refactor.extract.variable",
        isPreferred: false,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Extract to local variable", kind: "refactor.extract.variable" },
      };
    }

    function javaSymbols(text: string): LspDocumentSymbol[] {
      const symbols: LspDocumentSymbol[] = [];
      const build = (
        name: string,
        kind: number,
        depth: number,
        line: number,
        lineText: string,
      ): LspDocumentSymbol => {
        const column = Math.max(lineText.indexOf(name), 0);
        return {
          name,
          detail: null,
          kind,
          depth,
          range: { start: { line, character: 0 }, end: { line, character: lineText.length } },
          selectionRange: { start: { line, character: column }, end: { line, character: column + name.length } },
        };
      };
      text.split("\n").forEach((line, index) => {
        const classMatch = /^\s*(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (classMatch) {
          symbols.push(build(classMatch[1], 5, 0, index, line));
          return;
        }
        const methodMatch = /^\s{2,}(?:(?:public|private|protected|static|final)\s+)*([\w$<>\[\],.\s]+?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/.exec(line);
        const name = methodMatch?.[2];
        // Control-flow keywords also match the shape above; the real provider
        // reports methods only, so the fixture must not invent method symbols.
        const controlKeyword = name !== undefined && [
          "for", "if", "else", "while", "switch", "case", "catch", "finally",
          "do", "try", "return", "new", "throw", "assert", "synchronized",
        ].includes(name);
        if (methodMatch && !controlKeyword) symbols.push(build(name!, 6, 1, index, line));
      });
      return symbols;
    }

    function extractEdits() {
      return [
        {
          range: { start: { line: 4, character: 0 }, end: { line: 8, character: 0 } },
          newText: "        int sum = extracted(values);\n",
        },
        {
          range: { start: { line: 11, character: 0 }, end: { line: 11, character: 0 } },
          newText: "    private static int extracted(int[] values) {\n        int sum = 0;\n        for (int v : values) {\n            sum += v;\n        }\n        return sum;\n    }\n\n",
        },
      ];
    }

    interface ExtractFixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
      text: () => string;
    }

    function setupExtract(instanceId: string, mode: ExtractMode = "normal"): ExtractFixture {
      const disk: Record<string, string> = {
        [EXTRACT_PATH]: B0,
        [HELPER_PATH]: "package demo;\n\npublic class ExtractHelper {\n}\n",
      };
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-" + instanceId,
        workspaceInstanceId: instanceId,
        name: "Extract",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: EXTRACT_PATH },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("demo", "src/main/java/demo", "dir"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        workspaceTestHarness.file(path, disk[path] ?? "")
      ));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: "hash-" + text }));
      });
      const status = workspaceTestHarness.documentStatus({
        path: EXTRACT_ABS,
        uri: EXTRACT_URI,
        presetId: "java",
        languageId: "java",
        displayName: "Java",
        available: true,
        active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, documentSymbol: true, rename: true }),
      });
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
      workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
      workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(status);
      const text = () => selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instanceId,
      ).openFiles[EXTRACT_KEY]?.text ?? "";
      workspaceTestHarness.lspMocks.lspDocumentSymbols.mockImplementation(async () => {
        if (mode === "symbols-error") throw new Error("B-007 controlled documentSymbol failure");
        const symbols = javaSymbols(text());
        if (mode === "symbols-ambiguous" && /(extracted|sumOf)\(values\)/.test(text())) {
          symbols.push({
            name: "extractedExtra",
            detail: null,
            kind: 6,
            depth: 1,
            range: { start: { line: 12, character: 0 }, end: { line: 12, character: 0 } },
            selectionRange: { start: { line: 12, character: 0 }, end: { line: 12, character: 0 } },
          });
        }
        return { status, symbols };
      });
      workspaceTestHarness.lspMocks.lspCodeActions.mockImplementation(async () => {
        if (mode === "timeout") throw new Error("language server request timed out: textDocument/codeAction");
        if (mode === "changed") throw new Error("language server request cancelled: document changed");
        if (mode === "boom") throw new Error("B-007 controlled provider error");
        if (mode === "malformed") {
          return { status, actions: [null, { kind: "quickfix" }] as unknown as LspCodeAction[] };
        }
        if (mode === "none") return { status, actions: [extractVariableAction()] };
        if (mode === "disabled") {
          return { status, actions: [extractMethodAction("Extract to method", "The selected block has several outputs")] };
        }
        if (mode === "multi") {
          return {
            status,
            actions: [
              extractMethodAction("Extract to method"),
              extractMethodAction("Extract to method (second)"),
              extractMethodAction("Extract to method (unavailable)", "Not available for this selection"),
            ],
          };
        }
        if (mode === "multi-mixed") {
          // Two method candidates plus non-method extraction kinds. The Extract
          // Method menu must list only the methods.
          return {
            status,
            actions: [
              extractMethodAction("Extract to method"),
              extractMethodAction("Extract to method (second)"),
              extractVariableAction(),
              {
                title: "Extract to constant",
                kind: "refactor.extract.constant",
                isPreferred: false,
                edit: null,
                command: null,
                commandArguments: null,
                raw: { title: "Extract to constant", kind: "refactor.extract.constant" },
              },
            ],
          };
        }
        if (mode === "command-only") {
          return {
            status,
            actions: [{
              title: "Extract to method",
              kind: "refactor.extract.function",
              isPreferred: true,
              edit: null,
              command: "demo.unknownExtract",
              commandArguments: [],
              raw: { title: "Extract to method", kind: "refactor.extract.function", command: "demo.unknownExtract", arguments: [] },
            }],
          };
        }
        return { status, actions: [extractMethodAction("Extract to method"), extractVariableAction()] };
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockImplementation(async (_descriptor: unknown, raw: unknown) => {
        if (mode === "resolve-error") return { status, action: null };
        const action = raw as Record<string, unknown>;
        const documentEdits = [{ uri: EXTRACT_URI, path: EXTRACT_ABS, edits: extractEdits() }];
        if (mode === "multi-file") {
          // A real multi-file method extraction crosses into the shared preview.
          documentEdits.push({
            uri: HELPER_URI,
            path: HELPER_ABS,
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "// extract-cross-file\n",
            }],
          });
        }
        return { status, action: { ...action, edit: { documentEdits } } };
      });
      workspaceTestHarness.lspMocks.lspPrepareRename.mockResolvedValue({
        status,
        allowed: true,
        range: { start: { line: 11, character: 15 }, end: { line: 11, character: 24 } },
        placeholder: "extracted",
        message: null,
      });
      workspaceTestHarness.lspMocks.lspRename.mockImplementation(async (_descriptor: unknown, _position: unknown, newName: string) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
          throw new Error("B-007 controlled rename failure: '" + newName + "' is not a valid identifier");
        }
        if (mode === "rename-error") throw new Error("B-007 controlled rename failure: name rejected");
        const current = text();
        const lines = current.split("\n");
        if (mode === "rename-multi-file") {
          // The rename itself is multi-file, so the shared preview sits between
          // the last owner check and the first writer.
          return {
            status,
            edit: {
              documentEdits: [{
                uri: EXTRACT_URI,
                path: EXTRACT_ABS,
                edits: [{
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? "").length },
                  },
                  newText: current.split("extracted").join(newName),
                }],
              }, {
                uri: HELPER_URI,
                path: HELPER_ABS,
                edits: [{
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "// rename-cross-file\n",
                }],
              }],
            },
          };
        }
        return {
          status,
          edit: {
            documentEdits: [{
              uri: EXTRACT_URI,
              path: EXTRACT_ABS,
              edits: [{
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? "").length },
                },
                newText: current.split("extracted").join(newName),
              }],
            }],
          },
        };
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange, text };
    }

    async function mountExtract(fixture: ExtractFixture) {
      workspaceTestHarness.renderWorkspace(fixture.workspace, { onCommandsChange: fixture.onCommandsChange });
      await screen.findByTitle(EXTRACT_TITLE);
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), fixture.workspace.workspaceInstanceId!)
          .lspFiles[EXTRACT_KEY]?.syncedText,
      ).toBe(B0));
      await waitFor(() => expect(fixture.registrationRef.current?.items.find(
        (item) => item.id === "workspace.extractMethod",
      )?.enabled).toBe(true));
      const pane = screen.getByTestId("code-workspace-editor-pane");
      const content = pane.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      return { pane, content: content! };
    }

    function selectExtractRange(content: HTMLElement) {
      const view = EditorView.findFromDOM(content);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({
          selection: EditorSelection.range(
            view!.state.doc.line(5).from,
            view!.state.doc.line(9).from,
          ),
        });
      });
      content.focus();
      return view!;
    }

    function pressExtractChord(pane: HTMLElement) {
      fireEvent.keyDown(pane, { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
    }

    it("Ctrl+Alt+M runs the only method candidate without a menu and prompts for a name", async () => {
      const fixture = setupExtract(EXTRACT_INSTANCE);
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);

      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled());
      // DEC-02: the method candidate is applied directly; no frozen menu appears.
      expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
      // Only the method candidate was resolved (the variable candidate is filtered out).
      expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);

      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(screen.getByTestId("text-input-dialog")).toHaveTextContent("Extract Method");
      expect(input).toHaveValue("extracted");
      expect((input as HTMLInputElement).selectionStart).toBe(0);
      expect((input as HTMLInputElement).selectionEnd).toBe("extracted".length);

      await waitFor(() => expect(fixture.text()).toBe(B1));
      await waitFor(() => expect(fixture.disk[EXTRACT_PATH]).toBe(B1));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));
      expect(screen.queryByTestId("code-workspace-intention-extract")).not.toBeInTheDocument();
    });

    it("Enter renames call site and declaration; Escape keeps the default name", async () => {
      const fixture = setupExtract("instance-extract-enter");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));

      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(B2));
      expect(fixture.text()).toContain("int sumOf(int[] values)");
      expect(fixture.text()).toContain("int sum = sumOf(values);");
      expect(workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledWith(expect.anything(), expect.anything(), "sumOf");
      await waitFor(() => expect(fixture.disk[EXTRACT_PATH]).toBe(B2));
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      // DEC-03: the naming step hands the caret back on the call-statement line.
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(
        view.state.doc.lineAt(view.state.selection.main.head).text,
      ).toBe("        int sum = sumOf(values);"));

      // Fresh setup: the watcher echo of the extract's own save, delivered while
      // the naming prompt is open, is not a workspace change (no stale cancel).
      await cleanup();
      workspaceTestHarness.runtimeState.tauri = true;
      const echoed = setupExtract("instance-extract-echo");
      const echo = await mountExtract(echoed);
      selectExtractRange(echo.content);
      pressExtractChord(echo.pane);
      const echoInput = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(echoed.disk[EXTRACT_PATH]).toBe(B1));
      await act(async () => {
        await emit("lsp://external-file-change", { workspaceId: "instance-extract-echo", path: EXTRACT_ABS, type: 2 });
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      fireEvent.change(echoInput, { target: { value: "sumOf" } });
      fireEvent.keyDown(echoInput, { key: "Enter" });
      await waitFor(() => expect(echoed.text()).toBe(B2));
      expect(useAppStore.getState().statusMessage).not.toContain("workspace changed");
      workspaceTestHarness.runtimeState.tauri = false;

      // Fresh setup: Escape keeps the provider default name and adds no history.
      await cleanup();
      const escaped = setupExtract("instance-extract-escape");
      const second = await mountExtract(escaped);
      selectExtractRange(second.content);
      pressExtractChord(second.pane);
      const escapeInput = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(escaped.text()).toBe(B1));
      const renamesBeforeEscape = workspaceTestHarness.lspMocks.lspRename.mock.calls.length;
      fireEvent.keyDown(escapeInput, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());
      expect(escaped.text()).toBe(B1);
      expect(workspaceTestHarness.lspMocks.lspRename.mock.calls.length).toBe(renamesBeforeEscape);
    });

    it("renames the extracted method while provider indexing remains active", async () => {
      workspaceTestHarness.runtimeState.tauri = true;
      const fixture = setupExtract("instance-extract-progress");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.disk[EXTRACT_PATH]).toBe(B1));
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
      await waitFor(() => expect(fixture.disk[EXTRACT_PATH]).toBe(B2));
      expect(fixture.text()).toBe(B2);
      expect(useAppStore.getState().statusMessage).not.toContain("stale");
      workspaceTestHarness.runtimeState.tauri = false;
    });

    it("two editor undos and redos restore each transaction", async () => {
      const fixture = setupExtract("instance-extract-undo");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(B2));

      content.focus();
      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
      expect(useAppStore.getState().statusMessage).toContain("Undid Rename symbol");

      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
      await waitFor(() => expect(fixture.text()).toBe(B0));
      expect(useAppStore.getState().statusMessage).toContain("Undid");

      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(fixture.text()).toBe(B2));
    });

    it("multiple method candidates support keyboard and pointer selection", async () => {
      const fixture = setupExtract("instance-extract-multi", "multi");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);

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
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalled());
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      expect(input).toHaveValue("extracted");
    });

    it("empty selection follows actual method availability", async () => {
      const available = setupExtract("instance-extract-empty-ok");
      const first = await mountExtract(available);
      const view = EditorView.findFromDOM(first.content)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(5).from) });
      });
      first.content.focus();
      pressExtractChord(first.pane);
      // The provider still offers a method extraction for the caret statement.
      await waitFor(() => expect(available.text()).toBe(B1));
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(input).toHaveValue("extracted");
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());

      await cleanup();
      const none = setupExtract("instance-extract-empty-none", "none");
      const second = await mountExtract(none);
      const secondView = EditorView.findFromDOM(second.content)!;
      act(() => {
        secondView.dispatch({ selection: EditorSelection.cursor(secondView.state.doc.line(5).from) });
      });
      second.content.focus();
      pressExtractChord(second.pane);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
        "Extract Method: select the statements or expression to extract",
      ));
      expect(none.text()).toBe(B0);
      expect(none.disk[EXTRACT_PATH]).toBe(B0);
      // Only the earlier empty-selection success resolved a candidate; the
      // zero-candidate boundary path resolves nothing.
      expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);
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
      const fixture = setupExtract("instance-extract-" + entryCase.mode, entryCase.mode);
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(entryCase.expect));
      expect(fixture.disk[EXTRACT_PATH]).toBe(B0);
      expect(fixture.text()).toBe(B0);
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
    });

    it("dirty buffer extracts without saving or prompting", async () => {
      const fixture = setupExtract("instance-extract-dirty");
      const { pane, content } = await mountExtract(fixture);
      const view = EditorView.findFromDOM(content)!;
      act(() => {
        view.dispatch({ changes: { from: 0, to: 0, insert: "// pending\n" } });
      });
      await waitFor(() => expect(fixture.text()).toContain("// pending"));
      selectExtractRange(content);
      pressExtractChord(pane);

      await waitFor(() => expect(fixture.text()).toContain("extracted(values)"));
      expect(fixture.text()).toContain("// pending");
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(fixture.disk[EXTRACT_PATH]).toBe(B0);
      expect(useAppStore.getState().statusMessage).toContain("save the file, then press Shift+F6");
    });

    it("ambiguous or failed symbol snapshots preserve the extraction", async () => {
      for (const mode of ["symbols-error", "symbols-ambiguous"] as ExtractMode[]) {
        const fixture = setupExtract("instance-extract-" + mode, mode);
        const { pane, content } = await mountExtract(fixture);
        selectExtractRange(content);
        pressExtractChord(pane);
        // DEC-03 re-reads a damaged outline once, so the naming chain settles
        // after two provider samples per side.
        await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
          "Extracted method; could not locate the new method to rename it",
        ), { timeout: 6000 });
        expect(fixture.text()).toBe(B1);
        expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
        expect(workspaceTestHarness.lspMocks.lspRename).not.toHaveBeenCalled();
        await cleanup();
      }
    });

    it("name input validates and retries without repeating extraction", async () => {
      const fixture = setupExtract("instance-extract-retry");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      fireEvent.change(input, { target: { value: "1bad" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // The provider rejects the name; the prompt reopens with the user's input
      // and the committed extraction is never repeated.
      const retry = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(retry).toHaveValue("1bad");
      expect(fixture.text()).toBe(B1);
      expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1);
      fireEvent.change(retry, { target: { value: "sumOf" } });
      fireEvent.keyDown(retry, { key: "Enter" });
      await waitFor(() => expect(fixture.text()).toBe(B2));
      expect(workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(2);
    });

    it("late responses cannot reopen naming or rename another document", async () => {
      const fixture = setupExtract("instance-extract-late");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);

      // Hold the symbols-after sample, edit the committed buffer, then release:
      // the naming chain must not prompt or write for the stale receipt.
      let releaseSymbols: (() => void) | null = null;
      const originalSymbols = workspaceTestHarness.lspMocks.lspDocumentSymbols.getMockImplementation()!;
      workspaceTestHarness.lspMocks.lspDocumentSymbols.mockImplementation(async (descriptor: unknown) => {
        const result = await originalSymbols(descriptor);
        // Hold only the post-extraction sample, whichever call reaches it.
        if (!releaseSymbols && fixture.text().includes("extracted(values)")) {
          await new Promise<void>((resolve) => { releaseSymbols = resolve; });
        }
        return result;
      });

      pressExtractChord(pane);
      await waitFor(() => expect(releaseSymbols).not.toBeNull());
      const view = EditorView.findFromDOM(content)!;
      act(() => {
        view.dispatch({ changes: { from: 0, to: 0, insert: "// external\n" } });
      });
      await waitFor(() => expect(fixture.text()).toContain("// external"));
      releaseSymbols!();
      await waitFor(() => expect(fixture.text()).toContain("extracted(values)"));
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(workspaceTestHarness.lspMocks.lspRename).not.toHaveBeenCalled();
    });
    it("Escape in the retry prompt cancels the naming step without replaying the rejected name", async () => {
      // Regression: a dismissed retry prompt is not a provider empty edit. Before
      // the fix the loop replayed the previously entered name and renamed both
      // the declaration and the call site without any user confirmation.
      const fixture = setupExtract("instance-extract-cancel-retry", "rename-error");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));

      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      const retry = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      expect(retry).toHaveValue("sumOf");
      expect(workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(retry, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument());
      // Wait past the empty-edit replay delay: nothing may run on its own.
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, 1600); });
      });
      expect(workspaceTestHarness.lspMocks.lspRename).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("text-input-dialog")).not.toBeInTheDocument();
      expect(fixture.text()).toBe(B1);
      expect(fixture.text()).toContain("int sum = extracted(values);");
      expect(fixture.disk[EXTRACT_PATH]).toBe(B1);
    });

    it("extract preview keeps the declaration and call site as required edits", async () => {
      // Regression: the multi-file extraction preview offered every operation as
      // excludable, so Deselect All could commit a broken partial extraction.
      const fixture = setupExtract("instance-extract-preview-required", "multi-file");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);

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
      await waitFor(() => expect(fixture.text()).toBe(B1));
      expect(fixture.text()).toContain("int sum = extracted(values);");
      expect(fixture.text()).toContain("private static int extracted(int[] values) {");
      expect(fixture.disk[HELPER_PATH]).toContain("// extract-cross-file");
    });

    it("a stale rename names the invalidation that cancelled it", async () => {
      // "the workspace changed" alone cannot separate a real concurrent edit
      // from a watcher echo, so the status must carry reason, path and revisions.
      // The watcher listener is registered at mount, so the Tauri runtime must be
      // on before the workspace renders for an external change to arrive.
      workspaceTestHarness.runtimeState.tauri = true;
      const fixture = setupExtract("instance-rename-stale-detail");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));

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
      workspaceTestHarness.runtimeState.tauri = false;
    });

    it("a view switch while the rename preview is open never renames the abandoned file", async () => {
      // DEC-07: the owner guard runs again at the preflight and at the exact
      // mutation boundary, so an async preview cannot commit a rename for a
      // document the user has left.
      const fixture = setupExtract("instance-extract-owner-guard", "rename-multi-file");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);

      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      fireEvent.change(input, { target: { value: "sumOf" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const dialog = await screen.findByTestId("refactoring-preview-dialog");
      // Switch the active view while the rename is paused on the preview.
      fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));
      await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane").length).toBeGreaterThan(1));

      fireEvent.click(within(dialog).getByTestId("refactoring-preview-apply"));
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, 300); });
      });
      expect(fixture.text()).not.toContain("sumOf");
      expect(fixture.disk[EXTRACT_PATH]).not.toContain("sumOf");
      expect(fixture.disk[HELPER_PATH]).not.toContain("// rename-cross-file");
    });

    it("the Extract Method menu lists only method candidates", async () => {
      // DEC-02: two method candidates plus variable/constant proposals must not
      // widen the menu, and no second provider request may run for it.
      const fixture = setupExtract("instance-extract-mixed-menu", "multi-mixed");
      const { pane, content } = await mountExtract(fixture);
      selectExtractRange(content);
      pressExtractChord(pane);

      const menu = await screen.findByTestId("context-menu");
      const candidates = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[data-testid^="code-workspace-intention-"]'),
      );
      expect(candidates).toHaveLength(2);
      expect(candidates.every((item) => (item.textContent ?? "").includes("Extract to method"))).toBe(true);
      expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1);
      expect(within(menu).queryByText("Extract to local variable")).not.toBeInTheDocument();
      expect(within(menu).queryByText(/Extract to constant/)).not.toBeInTheDocument();

      fireEvent.click(candidates[0]!);
      const input = await screen.findByTestId("text-input-dialog-input", {}, { timeout: 5_000 });
      await waitFor(() => expect(fixture.text()).toBe(B1));
      expect(input).toHaveValue("extracted");
    });

  });
}

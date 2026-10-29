import { findEditorByTitle } from "./editorReadiness";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, vi } from "vitest";
import type { LspCodeAction, LspDocumentSymbol } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { registerextractMethodHistory1Cases } from "./tests/extractMethod/history1.cases";
import type { ExtractFixture, ExtractMode } from "./tests/extractMethod/model";
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
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange, text };
    }

    async function mountExtract(fixture: ExtractFixture) {
      workspaceTestHarness.renderWorkspace(fixture.workspace, { onCommandsChange: fixture.onCommandsChange });
      await findEditorByTitle(EXTRACT_TITLE);
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
    registerextractMethodHistory1Cases({
      get setupExtract() { return setupExtract; },
      get EXTRACT_INSTANCE() { return EXTRACT_INSTANCE; },
      get mountExtract() { return mountExtract; },
      get selectExtractRange() { return selectExtractRange; },
      get pressExtractChord() { return pressExtractChord; },
      get workspaceTestHarness() { return workspaceTestHarness; },
      get B1() { return B1; },
      get EXTRACT_PATH() { return EXTRACT_PATH; },
      get B2() { return B2; },
      get EXTRACT_ABS() { return EXTRACT_ABS; },
      get B0() { return B0; },
      get HELPER_PATH() { return HELPER_PATH; },
    });

  });
}

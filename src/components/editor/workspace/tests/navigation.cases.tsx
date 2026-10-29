import { findEditorByTitle } from "./editorReadiness";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspDocumentHighlight, LspDocumentStatus } from "../../../../lib/editor/lsp";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerInteractionCasesFixture } from "./interaction.cases";

export function registerNavigationCases(workspaceTestHarness: registerInteractionCasesFixture) {
it("leaves navigation-bar keyboard state to the mounted breadcrumb surface", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-navigation-bar-keyboard",
      workspaceInstanceId: "instance-navigation-bar-keyboard",
      name: "Navigation Bar Keyboard",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("src", "src", "dir"),
      workspaceTestHarness.entry("README.md", "README.md"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;"));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    fireEvent.keyDown(content!, { key: "Home", code: "Home", altKey: true });
    const nav = await screen.findByTestId("code-workspace-breadcrumbs");
    await waitFor(() => expect(document.activeElement).toBe(nav));

    fireEvent.keyDown(nav, { key: "Home", code: "Home" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-0");
    fireEvent.keyDown(nav, { key: "Enter", code: "Enter" });

    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    expect(popup).toHaveAttribute("role", "listbox");
    const filter = within(popup).getByRole("combobox");
    fireEvent.keyDown(filter, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull());
    expect(document.activeElement).toBe(nav);
  });
it("opens call and type hierarchy from capability-gated shortcuts", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-hierarchy",
      workspaceInstanceId: "instance-hierarchy",
      name: "Hierarchy",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: true,
      typeHierarchy: true,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const hierarchyItem = {
      name: "main",
      detail: "module",
      kind: 12,
      uri: "file:///repo/app/src/main.ts",
      path: "/repo/app/src/main.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
      raw: { name: "main", data: "opaque" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "function main() {}"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    }));
    workspaceTestHarness.lspMocks.lspPrepareCallHierarchy.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true, capabilities }),
      items: [hierarchyItem],
    });
    workspaceTestHarness.lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true, capabilities }),
      items: [{ ...hierarchyItem, name: "Base", raw: { name: "Base" } }],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const editor = screen.getByTestId("code-workspace-editor-pane");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true, altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspPrepareCallHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Call Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-call-hierarchy-panel")).toHaveTextContent("main");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspPrepareTypeHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Type Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-type-hierarchy-panel")).toHaveTextContent("Base");
  });
it("opens a JDK / dependency class as a read-only library buffer", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-library-goto",
      workspaceInstanceId: "instance-library-goto",
      name: "Library goto",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      // A real jdtls advertises definition; Ctrl+B is host-dispatched (ED-PARITY-013).
      capabilities: workspaceTestHarness.defaultCapabilities({ definition: true }),
    });
    const classUri = "jdt://contents/java.base/java.lang/String.class?=java.base";
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
      workspaceTestHarness.file("src/Main.java", "class Main { String value; }"),
    );
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    // jdtls answers binary targets with a jdt:// URI and no filesystem path.
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: {
          start: { line: 3, character: 13 },
          end: { line: 3, character: 19 },
        },
      }],
    });
    const charSequenceUri = "jdt://contents/java.base/java.lang/CharSequence.class?=java.base";
    workspaceTestHarness.lspMocks.lspReadUriContents.mockImplementation(async (_descriptor: unknown, uri: string) => (
      uri === charSequenceUri
        ? {
          status: activeStatus,
          uri,
          path: null,
          title: "CharSequence.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic interface CharSequence {}\n",
          readOnly: true,
        }
        : {
          status: activeStatus,
          uri,
          path: null,
          title: "String.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic final class String implements CharSequence {}\n",
          readOnly: true,
        }
    ));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/Main.java");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    // ED-PARITY-013: F12 is Jump to Last Tool Window; Ctrl+B navigates.
    fireEvent.keyDown(content!, { key: "b", code: "KeyB", ctrlKey: true });

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    const libraryTab = await findEditorByTitle("java.lang · java.base · String.java");
    expect(libraryTab).toBeInTheDocument();
    // Library sources never touch the file system, and never open a server document.
    expect(workspaceTestHarness.workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(workspaceTestHarness.lspMocks.lspOpenDocument).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: classUri }),
      expect.anything(),
      expect.anything(),
    );

    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Opened java.lang · java.base · String.java (read-only)"));

    // Jumping again from inside the library buffer rides the origin project's
    // session, and a URI reported as a "path" is never read from disk.
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: charSequenceUri,
        path: charSequenceUri,
        range: {
          start: { line: 2, character: 17 },
          end: { line: 2, character: 29 },
        },
      }],
    });
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "b", code: "KeyB", ctrlKey: true });

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/Main.java", documentUri: classUri }),
      charSequenceUri,
    ));
    expect(await findEditorByTitle("java.lang · java.base · CharSequence.java")).toBeInTheDocument();
    expect(workspaceTestHarness.workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });
it("offers Download sources on a decompiled class and swaps in attached source", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-sources",
      workspaceInstanceId: "instance-download-sources",
      name: "Download sources",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      // A real jdtls advertises definition; Ctrl+B is host-dispatched (ED-PARITY-013).
      capabilities: workspaceTestHarness.defaultCapabilities({ definition: true }),
    });
    const classUri = "jdt://contents/guava-33.jar/com.google.common.base/Strings.class?=guava";
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
      workspaceTestHarness.file("src/Main.java", "class Main { Strings s; }"),
    );
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
      }],
    });
    // First open returns decompiled bytecode (marked decompiled: true).
    workspaceTestHarness.lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Strings.java",
      container: "com.google.common.base · guava-33.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic final class Strings {}\n",
      readOnly: true,
      decompiled: true,
    });
    workspaceTestHarness.lspMocks.lspDownloadSources.mockResolvedValue({
      attached: true,
      text: "package com.google.common.base;\n\npublic final class Strings { /* real */ }\n",
      decompiled: false,
      message: null,
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "b", code: "KeyB", ctrlKey: true });

    // Decompiled banner + Download sources button appear for the library buffer.
    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();

    fireEvent.click(downloadBtn);

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDownloadSources).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    // Attached source arrives → banner disappears and status reports success.
    await waitFor(() => expect(screen.queryByTestId("code-workspace-decompiled-banner")).toBeNull());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Attached sources for Strings.java"));
    // Never written back to disk.
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
  });
it("keeps the Download sources banner when no sources are published", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-none",
      workspaceInstanceId: "instance-download-none",
      name: "Download none",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      // A real jdtls advertises definition; Ctrl+B is host-dispatched (ED-PARITY-013).
      capabilities: workspaceTestHarness.defaultCapabilities({ definition: true }),
    });
    const classUri = "jdt://contents/legacy.jar/com.legacy/Widget.class?=legacy";
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Main.java", "class Main { Widget w; }"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      }],
    });
    workspaceTestHarness.lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Widget.java",
      container: "com.legacy · legacy.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      readOnly: true,
      decompiled: true,
    });
    workspaceTestHarness.lspMocks.lspDownloadSources.mockResolvedValue({
      attached: false,
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      decompiled: true,
      message: "No sources published for this artifact (still showing decompiled bytecode).",
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "b", code: "KeyB", ctrlKey: true });

    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDownloadSources).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toContain("No sources published"));
    // Still decompiled → banner stays so the user can retry.
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();
  });
it("highlights usages at the caret the editor just reported, before the caret state commits", async () => {
    const { EditorView } = await import("@codemirror/view");
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-occurrence-fresh-caret", workspaceInstanceId: "instance-occurrence-fresh-caret",
      name: "Occurrence fresh caret", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [], initialFile: { kind: "root", rootId: "app", path: "notes.txt" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("notes.txt", "notes.txt")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("notes.txt", "item\nsecond item\nthird item"));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / notes.txt");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    let executePromise: Promise<unknown> | undefined;
    act(() => {
      // Caret onto the third "item" and run the action in the same task, as
      // Ctrl+End followed at once by Ctrl+Shift+F7 does.
      view.dispatch({ selection: { anchor: view.state.doc.length - 2 } });
      executePromise = registrationRef.current?.executeAction("workspace.highlightUsagesInFile");
    });
    await act(async () => {
      await executePromise;
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Occurrence 3 of 3"));
  });
it("does not restore occurrence highlights when a cleared request returns late", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-occurrence-stale-response",
      workspaceInstanceId: "instance-occurrence-stale-response",
      name: "Occurrence stale response",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = workspaceTestHarness.defaultCapabilities({ documentHighlight: true });
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    const highlights: LspDocumentHighlight[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, kind: 1 },
      { range: { start: { line: 1, character: 7 }, end: { line: 1, character: 11 } }, kind: 1 },
      { range: { start: { line: 2, character: 6 }, end: { line: 2, character: 10 } }, kind: 1 },
    ];
    const result = { status, highlights };
    const pending: Array<(
      value: { status: LspDocumentStatus; highlights: LspDocumentHighlight[] }
    ) => void> = [];
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main.ts",
      "item\nsecond item\nthird item",
    ));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDocumentHighlights.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));

    // Keep the first cursor-driven request unresolved while invoking the
    // explicit command through the same registered production action.
    workspaceTestHarness.lspMocks.lspDocumentHighlights.mockClear();
    let executePromise: Promise<unknown> | undefined;
    act(() => {
      executePromise = registrationRef.current?.executeAction("workspace.highlightUsagesInFile");
    });
    await waitFor(() => expect(pending.length).toBeGreaterThan(1));
    const manualResolve = pending[pending.length - 1]!;
    manualResolve(result);
    await act(async () => {
      await executePromise;
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Occurrence 1 of 3"));
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(3);

    act(() => {
      registrationRef.current?.executeAction("workspace.clearHighlightUsages");
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toBe("Occurrence highlights cleared"));
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(0);

    for (const resolve of pending) resolve(result);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(0);
  });
it("waits for a pending Java didChange before go-to-definition requests", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-definition-sync-barrier",
      workspaceInstanceId: "instance-definition-sync-barrier",
      name: "Definition sync barrier",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const source = "class Main { void target() {} void call() { target(); } }\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ definition: true }),
    });
    const target = {
      uri: "file:///repo/app/src/Main.java",
      path: "/repo/app/src/Main.java",
      range: { start: { line: 0, character: 19 }, end: { line: 0, character: 25 } },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Main.java", source));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [target] });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/Main.java");
    const fileKey = "root:app:src/Main.java";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-definition-sync-barrier")
        .lspFiles[fileKey]?.syncedText,
    ).toBe(source));
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDefinition",
    )?.enabled).toBe(true));

    let releaseFirstChange!: () => void;
    let changeCalls = 0;
    workspaceTestHarness.lspMocks.lspChangeDocument.mockImplementation(() => {
      changeCalls += 1;
      if (changeCalls === 1) {
        return new Promise((resolve) => {
          releaseFirstChange = () => resolve(status);
        });
      }
      return Promise.resolve(status);
    });

    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    const editedSource = `${source}// edited after completion\n`;
    act(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "// edited after completion\n" },
        userEvent: "input.type",
      });
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-definition-sync-barrier")
        .openFiles[fileKey]?.text,
    ).toBe(editedSource));
    await waitFor(() => expect(changeCalls).toBe(1), { timeout: 2_000 });

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.gotoDefinition");
      await Promise.resolve();
    });
    expect(workspaceTestHarness.lspMocks.lspDefinition).not.toHaveBeenCalled();

    await act(async () => {
      releaseFirstChange();
      await Promise.resolve();
    });
    await waitFor(() => expect(changeCalls).toBe(2));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/Main.java" }),
      expect.anything(),
      expect.objectContaining({ signal: expect.anything() }),
    ));
  });
it("applies the same sync barrier to Quick Definition and reports a retryable failure", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-quick-definition-sync-barrier",
      workspaceInstanceId: "instance-quick-definition-sync-barrier",
      name: "Quick Definition sync barrier",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const source = "class Main { void target() {} void call() { target(); } }\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ definition: true }),
    });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Main.java", source));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [] });

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/Main.java");
    const fileKey = "root:app:src/Main.java";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-quick-definition-sync-barrier")
        .lspFiles[fileKey]?.syncedText,
    ).toBe(source));

    workspaceTestHarness.lspMocks.lspChangeDocument.mockRejectedValue(new Error("didChange transport failed"));
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "// unsynchronized\n" },
        userEvent: "input.type",
      });
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-quick-definition-sync-barrier")
        .openFiles[fileKey]?.text,
    ).toContain("// unsynchronized"));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspChangeDocument).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "i", code: "KeyI", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "Definition navigation requires the language server to finish synchronizing current editor buffers",
    ), { timeout: 3_000 });
    expect(workspaceTestHarness.lspMocks.lspDefinition).not.toHaveBeenCalled();
  });
it("applies the sync barrier to declaration, type definition, and implementation navigation", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-semantic-navigation-sync-barrier",
      workspaceInstanceId: "instance-semantic-navigation-sync-barrier",
      name: "Semantic navigation sync barrier",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const source = "interface Service { void call(); }\nclass Main implements Service { public void call() {} }\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({
        definition: true,
        declaration: true,
        typeDefinition: true,
        implementation: true,
      }),
    });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Main.java", source));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [] });
    workspaceTestHarness.lspMocks.lspDeclaration.mockResolvedValue({ status, locations: [] });
    workspaceTestHarness.lspMocks.lspTypeDefinition.mockResolvedValue({ status, locations: [] });
    workspaceTestHarness.lspMocks.lspImplementation.mockResolvedValue({ status, locations: [] });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/Main.java");
    const fileKey = "root:app:src/Main.java";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-semantic-navigation-sync-barrier")
        .lspFiles[fileKey]?.syncedText,
    ).toBe(source));
    for (const commandId of [
      "workspace.gotoDeclaration",
      "workspace.gotoTypeDefinition",
      "workspace.gotoImplementation",
    ]) {
      await waitFor(() => expect(registrationRef.current?.items.find((item) => item.id === commandId)?.enabled).toBe(true));
    }

    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    let changeCalls = 0;
    let blockedCall = 0;
    let releaseBlocked: (() => void) | null = null;
    workspaceTestHarness.lspMocks.lspChangeDocument.mockImplementation(() => {
      changeCalls += 1;
      if (changeCalls === blockedCall) {
        return new Promise((resolve) => {
          releaseBlocked = () => resolve(status);
        });
      }
      return Promise.resolve(status);
    });

    const providerByCommand = {
      "workspace.gotoDeclaration": workspaceTestHarness.lspMocks.lspDefinition,
      "workspace.gotoTypeDefinition": workspaceTestHarness.lspMocks.lspTypeDefinition,
      "workspace.gotoImplementation": workspaceTestHarness.lspMocks.lspImplementation,
    } as const;
    for (const [index, commandId] of [
      "workspace.gotoDeclaration",
      "workspace.gotoTypeDefinition",
      "workspace.gotoImplementation",
    ].entries()) {
      const provider = providerByCommand[commandId as keyof typeof providerByCommand];
      provider.mockClear();
      blockedCall = changeCalls + 1;
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: `// semantic edit ${index}\n` },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(changeCalls).toBe(blockedCall), { timeout: 2_000 });

      let actionResult: unknown;
      await act(async () => {
        actionResult = registrationRef.current?.executeAction(commandId);
        await Promise.resolve();
      });
      expect(provider).not.toHaveBeenCalled();

      await act(async () => {
        releaseBlocked?.();
        await actionResult;
      });
      await waitFor(() => expect(changeCalls).toBe(blockedCall + 1));
      await waitFor(() => expect(provider, commandId).toHaveBeenCalled(), { timeout: 10_000 });
    }
  });
}

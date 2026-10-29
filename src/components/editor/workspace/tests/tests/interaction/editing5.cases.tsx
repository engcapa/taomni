import { findEditorByTitle } from "../../editorReadiness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionEditing5CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionEditing5Cases(caseContext: registerinteractionEditing5CasesContext) {
  it("resolves and runs the active Java main class from the workspace toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-run",
      workspaceInstanceId: "instance-java-run",
      name: "Java run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: "/repo/app/src/main/java/com/acme/App.java",
      command: "./mvnw -q -Dexec.mainClass='com.acme.App' compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));

    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalledWith(
      "/repo/app",
      "src/main/java/com/acme/App.java",
      undefined,
    ));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

  it("jumps to a mnemonic bookmark and uses Back to restore the origin", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-history",
      workspaceInstanceId: "instance-bookmark-history",
      name: "Bookmark history",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/one.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("one.ts", "src/one.ts"),
      caseContext.workspaceTestHarness.entry("two.ts", "src/two.ts"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/two.ts"
        ? caseContext.workspaceTestHarness.file(path, "zero\nmarked\n")
        : caseContext.workspaceTestHarness.file(path, "origin\n")
    ));
    window.localStorage.setItem(
      "taomni.codeWorkspace.bookmarks.v1.instance-bookmark-history",
      JSON.stringify([{
        id: "bookmark-two",
        fileKey: "root:app:src/two.ts",
        pathLabel: "app / src/two.ts",
        line: 1,
        character: 0,
        label: "marked",
        mnemonic: "J",
        group: "Mnemonic",
        state: "current",
        createdAt: 1,
      }]),
    );
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/one.ts");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    expect(registrationRef.current?.execute("workspace.jumpToBookmarkJ")).toBe(true);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/two.ts"));
    const backButton = caseContext.workspaceTestHarness.toolbarControl("code-workspace-nav-back");
    await waitFor(() => expect(backButton).not.toBeDisabled());
    fireEvent.click(backButton);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/one.ts"));
  });
  it("routes editor actions through ActionHost to the active recursive leaf", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-actions",
      workspaceInstanceId: "instance-editor-actions",
      name: "Editor Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? caseContext.workspaceTestHarness.file("src/util.ts", "alpha\nbeta")
        : caseContext.workspaceTestHarness.file("src/main.ts", "first\nsecond")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-editor-actions", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/main.ts");
    await findEditorByTitle("app / src/util.ts");
    const { EditorView } = await import("@codemirror/view");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary");
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");
    expect(primaryEditor).not.toBeNull();
    expect(secondaryEditor).not.toBeNull();
    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.cloneCaretBelow")?.enabled,
    ).toBe(true));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(1);

    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("secondary"));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(2);
  });
}

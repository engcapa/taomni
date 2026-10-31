import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { findEditorByTitle } from "./editorReadiness";

export function registerPreviewSearchCases(h: Pick<WorkspaceTestFixture, "renderWorkspace" | "workspaceMocks" | "file" | "entry">) {
  it("finds rendered markdown without switching to source or editing bytes", async () => {
    const text = "# Preview needle\n\nA **needle** in a [link](guide.md).\n\n```mermaid\ngraph TD\n A-->B\n```";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "preview-search", name: "Preview",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    h.workspaceMocks.workspaceReadFile.mockResolvedValue(h.file("README.md", text));
    h.renderWorkspace(workspace);
    await findEditorByTitle("app / README.md");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = await screen.findByTestId("code-workspace-markdown-preview");
    act(() => preview.focus());
    fireEvent.keyDown(preview, { key: "f", code: "KeyF", ctrlKey: true });
    const search = await screen.findByRole("searchbox", { name: "Find in preview" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "needle" } });
    await waitFor(() => expect(within(preview).getAllByTestId("markdown-search-match")).toHaveLength(2));
    expect(screen.getByTestId("markdown-search-count")).toHaveTextContent("1/2");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("markdown-search-count")).toHaveTextContent("2/2");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Find in preview" })).not.toBeInTheDocument();
    expect(preview).toHaveFocus();
    expect(within(preview).getByRole("link", { name: "link" })).toHaveAttribute("href", "guide.md");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await findEditorByTitle("app / README.md");
    expect(screen.getByTestId("code-workspace-editor").textContent).toContain("Preview needle");
    expect(h.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });

  it("searches non-source workspace documents from Ctrl+Shift+N", async () => {
    const paths = ["README.md", "Documents/notes.txt", "Documents/budget.csv", "config/application.properties", "pom.xml"];
    h.workspaceMocks.workspaceListFilesRecursive.mockResolvedValue(paths.map((path) => h.entry(path.split("/").pop()!, path)));
    h.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => h.file(path, `Document ${path}`));
    h.renderWorkspace({ repoRoot: "/repo/app", workspaceId: "mixed-search", name: "Mixed",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "Main.java" } });
    await findEditorByTitle("app / Main.java");
    for (const path of paths) {
      fireEvent.keyDown(window, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
      const query = await screen.findByLabelText("Go to file");
      fireEvent.change(query, { target: { value: path.split("/").pop() } });
      await waitFor(() => expect(screen.getByTestId("code-workspace-search-everywhere")).toHaveTextContent(path.split("/").pop()!));
      fireEvent.keyDown(query, { key: "Enter" });
      expect(await findEditorByTitle(`app / ${path}`)).toBeInTheDocument();
    }
  });
}

import { act, fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { type registerLayoutCasesFixture } from "../../layout.cases";

export function registerLayoutRenderingCases(harness: registerLayoutCasesFixture) {
  it("selects and navigates tree rows without rendering the editor owner", async () => {
    const { projectFactsMock } = await import("../../../../tests/codeWorkspaceTab/harness");
    const instanceId = "tree-selection-owner";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceInstanceId: instanceId, name: "Selection owner",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
    };
    harness.workspaceMocks.workspaceListDir.mockResolvedValue([
      harness.entry("first.txt", "first.txt"), harness.entry("second.txt", "second.txt"),
    ]);
    const view = harness.renderWorkspace(workspace);
    try {
      await screen.findByText("second.txt");
      await act(async () => undefined);
      projectFactsMock.useProjectFacts.mockClear();
      fireEvent.click(screen.getByText("first.txt"));
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId).treeSelection)
        .toEqual({ kind: "file", ref: { kind: "root", rootId: "app", path: "first.txt" } });
      expect(screen.getByText("first.txt").closest("[role=treeitem]"))
        .toHaveAttribute("data-selected", "true");
      fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), { key: "ArrowDown" });
      expect(screen.getByText("second.txt").closest("[role=treeitem]"))
        .toHaveAttribute("data-selected", "true");
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId).treeSelection)
        .toEqual({ kind: "file", ref: { kind: "root", rootId: "app", path: "second.txt" } });
      expect(projectFactsMock.useProjectFacts).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
}

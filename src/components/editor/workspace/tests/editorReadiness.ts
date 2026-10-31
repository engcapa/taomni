import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** A file tab can appear before the first editor has finished mounting. */
export async function findEditorByTitle(title: Parameters<typeof screen.findByTitle>[0]) {
  const tab = await screen.findByTitle(title);
  await findEditorPanes();
  return tab;
}

export async function findEditorPanes(minimumEditors = 1) {
  return waitFor(() => {
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    expect(screen.queryAllByRole("status", { name: "Loading editor" })).toHaveLength(0);
    expect(panes.filter((pane) => pane.querySelector(".cm-content")).length).toBeGreaterThanOrEqual(minimumEditors);
    return panes;
  });
}

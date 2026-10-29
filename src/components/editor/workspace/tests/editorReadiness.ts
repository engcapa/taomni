import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** A file tab can appear before the first editor has finished mounting. */
export async function findEditorByTitle(title: Parameters<typeof screen.findByTitle>[0]) {
  const tab = await screen.findByTitle(title);
  await findEditorPanes();
  return tab;
}

export async function findEditorPanes() {
  return waitFor(() => {
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    expect(screen.queryAllByRole("status", { name: "Loading editor" })).toHaveLength(0);
    expect(panes.some((pane) => pane.querySelector(".cm-content"))).toBe(true);
    return panes;
  });
}

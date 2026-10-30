import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Breadcrumbs, type BreadcrumbPathChild } from "./Breadcrumbs";

afterEach(cleanup);

it("keeps a pending path popup through a late caret update on the same trail", async () => {
  let finishListing!: (children: BreadcrumbPathChild[]) => void;
  const loadPathChildren = vi.fn(() => new Promise<BreadcrumbPathChild[]>((resolve) => { finishListing = resolve; }));
  const onPathNavigate = vi.fn();
  const props = {
    pathSegments: [
      { label: "repo", path: "", kind: "root" as const },
      { label: "README.txt", path: "README.txt", kind: "file" as const },
    ],
    symbols: [], loadPathChildren, onPathNavigate, activeNavigationBar: true,
  };
  const view = render(<Breadcrumbs {...props} position={{ line: 0, character: 0 }} />);
  const nav = screen.getByTestId("code-workspace-breadcrumbs");
  fireEvent.keyDown(nav, { key: "Home" });
  fireEvent.keyDown(nav, { key: "Enter" });
  const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
  view.rerender(<Breadcrumbs {...props} position={{ line: 3, character: 0 }} />);
  expect(screen.getByTestId("code-workspace-breadcrumb-popup")).toBe(popup);
  await act(async () => finishListing([
    { label: "src", path: "src", kind: "directory" },
    { label: "README.txt", path: "README.txt", kind: "file", active: true },
  ]));
  const option = await within(popup).findByRole("option", { name: "src" });
  await waitFor(() => expect(within(popup).getByRole("combobox")).toHaveFocus());
  fireEvent.click(option);
  expect(onPathNavigate).toHaveBeenCalledWith(expect.objectContaining({ path: "src" }), props.pathSegments[0]);
  expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull();
});

it("closes symbol navigation when a caret update changes the active symbol trail", () => {
  const symbols = [0, 10].map((line) => ({
    name: `Symbol${line}`, detail: null, kind: 5, depth: 0,
    range: { start: { line, character: 0 }, end: { line: line + 5, character: 0 } },
    selectionRange: { start: { line, character: 0 }, end: { line, character: 7 } },
  }));
  const props = { pathSegments: [{ label: "App.ts", path: "App.ts", kind: "file" as const }], symbols };
  const view = render(<Breadcrumbs {...props} position={{ line: 1, character: 0 }} />);
  fireEvent.click(screen.getByTestId("code-workspace-breadcrumb-symbol"));
  expect(screen.getByTestId("code-workspace-breadcrumb-popup")).toBeVisible();
  view.rerender(<Breadcrumbs {...props} position={{ line: 11, character: 0 }} />);
  expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull();
});

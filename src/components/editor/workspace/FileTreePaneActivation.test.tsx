import { createRef, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileTreePane } from "./FileTreePane";

const translate = vi.hoisted(() => vi.fn((key: string) => key));
vi.mock("../../../lib/i18n", () => ({ useT: () => translate }));

afterEach(() => { cleanup(); translate.mockClear(); });

function paneProps(): ComponentProps<typeof FileTreePane> {
  return {
    paneRef: createRef<HTMLElement>(), style: {}, filter: "", viewMode: "tree",
    fontSize: 12, minFontSize: 10, maxFontSize: 20, defaultFontSize: 12,
    canCreate: true, canMutateSelection: true, children: <span>First document</span>,
    onFilterChange: vi.fn(), onViewModeChange: vi.fn(), onFontSizeChange: vi.fn(),
    onOpenFile: vi.fn(), onAddFolder: vi.fn(), onCreateFile: vi.fn(),
    onCreateDirectory: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
    onSelectOpenedFile: vi.fn(), onToggleCollapse: vi.fn(),
  };
}

it("keeps the project toolbar out of document activation renders and calls current handlers", () => {
  const props = paneProps();
  const { rerender } = render(<FileTreePane {...props} />);
  const latestLocate = vi.fn();
  const latestAddFolder = vi.fn();
  translate.mockClear();
  rerender(<FileTreePane {...props} onSelectOpenedFile={latestLocate} onAddFolder={latestAddFolder}>
    <span>Second document</span>
  </FileTreePane>);
  expect(screen.getByText("Second document")).toBeVisible();
  expect(translate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("code-workspace-tree-select-opened"));
  expect(latestLocate).toHaveBeenCalledOnce();
  expect(props.onSelectOpenedFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("code-workspace-tree-new"));
  fireEvent.click(screen.getByTestId("code-workspace-tree-add-folder"));
  expect(latestAddFolder).toHaveBeenCalledOnce();
  expect(props.onAddFolder).not.toHaveBeenCalled();
});

it("updates toolbar availability, view, collapsed state and search focus", () => {
  const props = paneProps();
  const { rerender } = render(<FileTreePane {...props} />);
  rerender(<FileTreePane {...props} viewMode="list" collapsed onSelectOpenedFile={undefined} />);
  expect(screen.queryByTestId("code-workspace-tree-select-opened")).toBeNull();
  expect(screen.getByTestId("code-workspace-tree-view-selector")).toHaveTextContent("List");
  expect(screen.getByTestId("code-workspace-tree-collapse")).toHaveAccessibleName("Show project tree");
  fireEvent.click(screen.getByTestId("code-workspace-tree-search"));
  expect(screen.getByTestId("code-workspace-tree-filter")).toHaveFocus();
});

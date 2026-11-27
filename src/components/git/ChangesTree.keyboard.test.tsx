import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChangesTree } from "./ChangesTree";

it("opens directories and selects paths without toggling a nested checkbox or staging files", () => {
  const select = vi.fn();
  const check = vi.fn();
  const stage = vi.fn();
  render(<ChangesTree changes={[{ path: "docs/file.txt", oldPath: null, status: "modified", staged: false, unstaged: true, conflict: false }]}
    treeMode grouped={false} checked={new Set()} selected={new Set()} activePath={null}
    onSelect={select} onToggleChecked={check} onStagePaths={stage} onContextMenu={vi.fn()} />);
  const folder = screen.getByRole("button", { name: "docs" });
  fireEvent.keyDown(folder, { key: " " });
  expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("file.txt")).toBeNull();
  fireEvent.keyDown(folder, { key: "Enter" });
  const file = screen.getByText("file.txt").closest('[role="button"]')!;
  fireEvent.keyDown(file, { key: "Enter", metaKey: true, shiftKey: true });
  expect(select).toHaveBeenCalledExactlyOnceWith("docs/file.txt", { ctrl: true, shift: true });
  const checkbox = screen.getByRole("checkbox", { name: "docs/file.txt" });
  fireEvent.keyDown(checkbox, { key: " " });
  fireEvent.click(checkbox);
  expect(select).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledExactlyOnceWith(["docs/file.txt"], true);
  expect(stage).not.toHaveBeenCalled();
});

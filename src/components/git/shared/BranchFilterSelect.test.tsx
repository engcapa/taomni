import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchFilterSelect } from "./BranchFilterSelect";

afterEach(() => {
  cleanup();
});

describe("BranchFilterSelect", () => {
  it("opens a searchable menu and filters branches", () => {
    const onChange = vi.fn();
    render(
      <BranchFilterSelect
        value="__current__"
        onChange={onChange}
        branches={[
          { value: "main", name: "main", date: "2026-01-01T00:00:00Z" },
          { value: "feature/ui", name: "feature/ui", date: "2026-03-01T00:00:00Z" },
          { value: "hotfix", name: "hotfix", date: "2026-02-01T00:00:00Z" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    const menu = screen.getByTestId("git-branch-filter-menu");
    expect(menu).toBeInTheDocument();

    // Sorted by date desc: feature/ui, hotfix, main (after specials)
    const options = screen.getAllByTestId("git-branch-filter-option");
    expect(options.map((el) => el.getAttribute("data-value"))).toEqual([
      "__current__",
      "__all__",
      "feature/ui",
      "hotfix",
      "main",
    ]);

    fireEvent.change(screen.getByLabelText("Filter branches"), { target: { value: "hot" } });
    const filtered = screen.getAllByTestId("git-branch-filter-option");
    expect(filtered.map((el) => el.getAttribute("data-value"))).toEqual(["hotfix"]);

    fireEvent.click(filtered[0]!);
    expect(onChange).toHaveBeenCalledWith("hotfix");
    expect(screen.queryByTestId("git-branch-filter-menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(
      <BranchFilterSelect
        value="__all__"
        onChange={() => {}}
        branches={[{ value: "main", name: "main" }]}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    expect(screen.getByTestId("git-branch-filter-menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("git-branch-filter-menu")).not.toBeInTheDocument();
  });
});

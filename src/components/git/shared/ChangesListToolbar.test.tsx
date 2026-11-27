import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangesListToolbar, emptyGitChangeFilters } from "./ChangesListToolbar";

afterEach(cleanup);

function renderToolbar(overrides: Partial<React.ComponentProps<typeof ChangesListToolbar>> = {}) {
  const props: React.ComponentProps<typeof ChangesListToolbar> = {
    busy: false,
    filter: "",
    onFilterChange: vi.fn(),
    filters: emptyGitChangeFilters(),
    onToggleStageFilter: vi.fn(),
    onToggleStatusFilter: vi.fn(),
    onClearFilters: vi.fn(),
    checkedCount: 0,
    totalCount: 3,
    visibleCount: 3,
    visibleStagedCount: 1,
    treeMode: true,
    onCheckVisible: vi.fn(),
    onUncheckVisible: vi.fn(),
    onStageVisible: vi.fn(),
    onUnstageVisible: vi.fn(),
    onToggleTreeMode: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ChangesListToolbar {...props} />) };
}

describe("ChangesListToolbar", () => {
  it("opens shared filter ContextMenu, keeps multi-select checkboxes open, and dismisses cleanly", async () => {
    const { props } = renderToolbar();
    const filterButton = screen.getByRole("button", { name: /Change filters/i });
    filterButton.focus();

    fireEvent.click(filterButton);
    const menu = screen.getByTestId("git-change-filter-dropdown");
    expect(menu).toHaveAttribute("role", "menu");
    expect(menu).toHaveFocus();

    const stagedItem = screen.getByTestId("context-menu-item-show-staged-changes");
    fireEvent.click(stagedItem);
    expect(props.onToggleStageFilter).toHaveBeenCalledWith("staged");
    // keepOpen preserves the checklist menu for multi-select toggles.
    expect(screen.getByTestId("git-change-filter-dropdown")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(screen.getByTestId("git-change-filter-dropdown")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("git-change-filter-dropdown")).not.toBeInTheDocument();
    await waitFor(() => expect(filterButton).toHaveFocus());
  });

  it("opens shared action menu, invokes action, and closes on selection or anchor toggle", () => {
    const { props } = renderToolbar();
    const moreButton = screen.getByRole("button", { name: /More change actions/i });

    fireEvent.click(moreButton);
    expect(screen.getByTestId("git-change-action-dropdown")).toBeInTheDocument();

    // Toggling the trigger anchor closes the menu.
    fireEvent.click(moreButton);
    expect(screen.queryByTestId("git-change-action-dropdown")).not.toBeInTheDocument();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByTestId("context-menu-item-check-visible-changes-3"));
    expect(props.onCheckVisible).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("git-change-action-dropdown")).not.toBeInTheDocument();
  });
});

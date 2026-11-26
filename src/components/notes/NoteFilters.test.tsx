import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteStatusFilter } from "./NoteFilters";

afterEach(cleanup);

describe("NoteStatusFilter", () => {
  it("opens shared ContextMenu, supports keyboard navigation and multi-select keepOpen, and restores trigger focus", async () => {
    const onToggleFilter = vi.fn();
    render(<NoteStatusFilter filters={["recent_incomplete", "pinned"]} onToggleFilter={onToggleFilter} />);

    const trigger = screen.getByTestId("notes-filter-menu");
    trigger.focus();
    fireEvent.click(trigger);

    const dropdown = screen.getByTestId("notes-filter-dropdown");
    expect(dropdown).toHaveAttribute("role", "menu");
    expect(dropdown).toHaveFocus();

    const completed = screen.getByTestId("notes-filter-completed");
    expect(screen.getByTestId("notes-filter-pinned")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(completed);
    expect(onToggleFilter).toHaveBeenCalledWith("completed");
    expect(screen.getByTestId("notes-filter-dropdown")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("notes-filter-dropdown")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    expect(screen.getByTestId("notes-filter-dropdown")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("notes-filter-dropdown")).not.toBeInTheDocument();
  });
});

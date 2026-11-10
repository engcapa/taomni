import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { NotesWorkspaceSearch } from "./NotesWorkspaceSearch";

function Harness({ initial = "missing", onSearch = vi.fn() }: { initial?: string; onSearch?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <NotesWorkspaceSearch value={value} onSearch={(next) => {
    setValue(next);
    onSearch(next);
  }} />;
}

afterEach(() => cleanup());

describe("NotesWorkspaceSearch", () => {
  it("clears a nonempty search from its accessible button and restores input focus", () => {
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    const input = screen.getByTestId("notes-workspace-search");
    const clear = screen.getByRole("button", { name: "Clear search" });
    input.focus();
    fireEvent.mouseDown(clear);
    fireEvent.click(clear);
    expect(onSearch).toHaveBeenCalledWith("");
    expect(input).toHaveValue("");
    expect(screen.queryByTestId("notes-workspace-search-clear")).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("clears a noncomposing Escape, keeps focus and stops propagation", () => {
    const onSearch = vi.fn();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><Harness onSearch={onSearch} /></div>);
    const input = screen.getByTestId("notes-workspace-search");
    input.focus();
    const consumed = createEvent.keyDown(input, { key: "Escape", keyCode: 27 });
    fireEvent(input, consumed);
    expect(consumed.defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("");
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("leaves an empty Escape untouched", () => {
    const onSearch = vi.fn();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><Harness initial="" onSearch={onSearch} /></div>);
    expect(screen.queryByTestId("notes-workspace-search-clear")).not.toBeInTheDocument();
    const event = createEvent.keyDown(screen.getByTestId("notes-workspace-search"), { key: "Escape" });
    fireEvent(screen.getByTestId("notes-workspace-search"), event);
    expect(event.defaultPrevented).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: "Escape", isComposing: true, keyCode: 0 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ])("does not clear or consume Escape during IME composition: %o", (keyboard) => {
    const onSearch = vi.fn();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><Harness initial="草稿" onSearch={onSearch} /></div>);
    const event = createEvent.keyDown(screen.getByTestId("notes-workspace-search"), keyboard);
    fireEvent(screen.getByTestId("notes-workspace-search"), event);
    expect(event.defaultPrevented).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });
});

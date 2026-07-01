import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localInputToSeconds } from "../../lib/notes";
import { NoteDateTimeField } from "./NoteDateTimeField";

afterEach(() => cleanup());

describe("NoteDateTimeField", () => {
  it("shows a time control and closes after choosing a calendar day", () => {
    const onChange = vi.fn();
    render(
      <NoteDateTimeField
        label="Due"
        value={localInputToSeconds("2026-07-10T08:00")}
        onChange={onChange}
        testId="note-editor-due"
      />,
    );

    fireEvent.click(screen.getByTestId("note-editor-due"));
    const time = screen.getByTestId("note-editor-due-time") as HTMLInputElement;
    expect(time.value).toBe("08:00");

    fireEvent.change(time, { target: { value: "09:45" } });
    fireEvent.click(screen.getByRole("button", { name: "15" }));

    expect(onChange).toHaveBeenLastCalledWith(localInputToSeconds("2026-07-15T09:45"));
    expect(screen.queryByTestId("note-editor-due-popover")).not.toBeInTheDocument();
  });

  it("clears an existing date-time value", () => {
    const onChange = vi.fn();
    render(
      <NoteDateTimeField
        label="Due"
        value={localInputToSeconds("2026-07-10T08:00")}
        onChange={onChange}
        testId="note-editor-due"
      />,
    );

    fireEvent.click(screen.getByTestId("note-editor-due-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

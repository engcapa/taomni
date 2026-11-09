import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localInputToSeconds } from "../../lib/notes";
import { NoteDateTimeField } from "./NoteDateTimeField";

afterEach(() => cleanup());

describe("NoteDateTimeField", () => {
  it("shows time sliders and closes after choosing a calendar day", () => {
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
    const hour = screen.getByTestId("note-editor-due-hour") as HTMLInputElement;
    const minute = screen.getByTestId("note-editor-due-minute") as HTMLInputElement;
    expect(hour.value).toBe("8");
    expect(minute.value).toBe("0");

    fireEvent.change(hour, { target: { value: "9" } });
    fireEvent.change(minute, { target: { value: "45" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "15" }));

    expect(onChange).toHaveBeenLastCalledWith(localInputToSeconds("2026-07-15T09:45"));
    expect(screen.queryByTestId("note-editor-due-popover")).not.toBeInTheDocument();
  });

  it("commits slider changes only when done is clicked", () => {
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
    fireEvent.change(screen.getByTestId("note-editor-due-hour"), { target: { value: "18" } });
    fireEvent.change(screen.getByTestId("note-editor-due-minute"), { target: { value: "30" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("note-editor-due-done"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(localInputToSeconds("2026-07-10T18:30"));
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

  it("keeps a typed timestamp through late updates and commits the full minutes on blur", () => {
    const onChange = vi.fn();
    const props = { label: "Reminder", testId: "reminder", onChange };
    const { rerender } = render(<NoteDateTimeField {...props} value={localInputToSeconds("2035-06-13T08:00")} />);
    const input = screen.getByTestId("reminder");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2035-06-13 08:1" } });
    expect(onChange).not.toHaveBeenCalled();

    rerender(<NoteDateTimeField {...props} value={localInputToSeconds("2035-06-13T08:01")} />);
    expect(input).toHaveValue("2035-06-13 08:1");
    fireEvent.change(input, { target: { value: "2035-06-13 08:15" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(localInputToSeconds("2035-06-13T08:15"));
  });

  it("commits Enter once and leaves composition input unsubmitted", () => {
    const onChange = vi.fn();
    render(<NoteDateTimeField label="Due" testId="due" value={null} onChange={onChange} />);
    const input = screen.getByTestId("due");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2035-06-13 08:15" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(localInputToSeconds("2035-06-13T08:15"));
  });

  it("restores invalid text on blur and follows external values when clean", () => {
    const onChange = vi.fn();
    const props = { label: "Due", testId: "due", onChange };
    const { rerender } = render(<NoteDateTimeField {...props} value={localInputToSeconds("2035-06-13T08:00")} />);
    const input = screen.getByTestId("due");
    fireEvent.change(input, { target: { value: "unfinished" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("2035-06-13 08:00");
    rerender(<NoteDateTimeField {...props} value={localInputToSeconds("2035-06-14T09:30")} />);
    expect(input).toHaveValue("2035-06-14 09:30");
  });
});

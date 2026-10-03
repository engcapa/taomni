import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);
import { useEffect, useRef, useState } from "react";
import { GoToLineDialog, parseGoToLineInput } from "./GoToLineDialog";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { useFocusReturn } from "./useFocusReturn";

describe("ED-PARITY-012 DEC-012-06: Go to Line:Column", () => {
  it("parses line[:column] within the document", () => {
    expect(parseGoToLineInput("12", 20)).toEqual({ line: 12, column: 1 });
    expect(parseGoToLineInput(" 2:3 ", 20)).toEqual({ line: 2, column: 3 });
    expect(parseGoToLineInput("2,3", 20)).toEqual({ line: 2, column: 3 });
    expect(parseGoToLineInput("0", 20)).toBeNull();
    expect(parseGoToLineInput("21", 20)).toBeNull();
    expect(parseGoToLineInput("2:0", 20)).toBeNull();
    expect(parseGoToLineInput("abc", 20)).toBeNull();
    expect(parseGoToLineInput("", 20)).toBeNull();
  });

  it("prefills and selects the caret position, Enter jumps", async () => {
    const onGo = vi.fn();
    render(<GoToLineDialog current={{ line: 4, column: 7 }} lineCount={10} onGo={onGo} onCancel={vi.fn()} />);
    const field = screen.getByTestId("code-workspace-goto-line-input") as HTMLInputElement;
    expect(field.value).toBe("4:7");
    await waitFor(() => expect(field).toHaveFocus());
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(3);
    fireEvent.change(field, { target: { value: "2:3" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onGo).toHaveBeenCalledWith({ line: 2, column: 3 });
  });

  it("disables OK for invalid input and Esc cancels without jumping", () => {
    const onGo = vi.fn();
    const onCancel = vi.fn();
    render(<GoToLineDialog current={{ line: 1, column: 1 }} lineCount={3} onGo={onGo} onCancel={onCancel} />);
    const field = screen.getByTestId("code-workspace-goto-line-input");
    fireEvent.change(field, { target: { value: "9" } });
    expect(screen.getByTestId("code-workspace-goto-line-ok")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("between 1 and 3");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onGo).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// Real surfaces focus their first field after mount (useEffect / timeout).
function FocusProbe({ open }: { open: boolean }) {
  useFocusReturn(open);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  return <input aria-label="popup" ref={ref} />;
}

describe("ED-PARITY-012 DEC-012-01: focus return", () => {
  it("returns focus to the opener when focus would be lost", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <button onClick={() => setOpen(false)}>closer</button>
          <FocusProbe open={open} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByLabelText("popup")).toHaveFocus());
    // Closing unmounts the focused input, dropping focus to body.
    fireEvent.click(screen.getByText("closer"));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("does not steal focus from a surface that took it", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button>opener</button>
          <input aria-label="other" />
          <button onClick={() => setOpen(false)}>closer</button>
          <FocusProbe open={open} />
        </>
      );
    }
    render(<Host />);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.click(screen.getByText("closer"));
    other.focus();
    await Promise.resolve();
    await Promise.resolve();
    expect(other).toHaveFocus();
  });
});

describe("ED-PARITY-012: QuickPick Esc", () => {
  it("closes on Esc even when focus is outside the overlay", () => {
    const onClose = vi.fn();
    render(
      <>
        <input aria-label="editor" />
        <QuickPickOverlay
          open
          testId="qp"
          inputLabel="Go to file"
          placeholder=""
          items={["a"]}
          filterItems={(_q, items) => items}
          itemKey={(item) => item}
          renderItem={(item) => item}
          emptyText={() => "none"}
          onClose={onClose}
          onPick={vi.fn()}
        />
      </>,
    );
    const editor = screen.getByLabelText("editor");
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

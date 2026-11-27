import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateWithPattern, PickerDialogs } from "./PickerDialogs";

afterEach(cleanup);

describe("notepad custom date insertion", () => {
  const date = new Date(2026, 10, 21, 9, 5, 7);

  it("expands the documented tokens with zero padding", () => {
    expect(formatDateWithPattern(date, "yyyy-MM-dd HH:mm:ss")).toBe("2026-11-21 09:05:07");
    expect(formatDateWithPattern(date, "yy/M/d H:m:s")).toBe("26/11/21 9:5:7");
  });

  it("keeps non-token literals and does not expand unknown tokens", () => {
    expect(formatDateWithPattern(date, "yyyy年MM月dd日 HH:mm:ss")).toBe("2026年11月21日 09:05:07");
    expect(formatDateWithPattern(date, "yyyy-QQ")).toBe("2026-QQ");
  });
});

describe("Open With picker TaOffice scoping and deferred Remember", () => {
  it("offers TaOffice for Office files and remembers it when selected", () => {
    const onOpenWith = vi.fn();
    const onRemember = vi.fn();
    const onClose = vi.fn();
    const shared = {
      onClose,
      onOpenWith,
      onRememberHandler: onRemember,
      onPaste: vi.fn(),
      onInsertText: vi.fn(),
      onCompare: vi.fn(),
      readClipboard: () => Promise.resolve(""),
    };

    const view = render(<PickerDialogs {...shared} modal={{ kind: "openWith", path: "/tmp/notes.txt" }} />);
    expect(screen.queryByTestId("notepad-open-with-taoffice")).toBeNull();

    // Checking Remember and cancelling does not persist the handler
    fireEvent.click(screen.getByTestId("notepad-open-with-remember-notepad"));
    expect(onRemember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("notepad-open-with-close"));
    expect(onRemember).not.toHaveBeenCalled();

    view.rerender(<PickerDialogs {...shared} modal={{ kind: "openWith", path: "/tmp/report.docx" }} />);
    const taoffice = screen.getByTestId("notepad-open-with-taoffice");
    expect(taoffice).toBeEnabled();
    fireEvent.click(screen.getByTestId("notepad-open-with-remember-taoffice"));
    expect(onRemember).not.toHaveBeenCalled();
    fireEvent.click(taoffice);
    expect(onRemember).toHaveBeenCalledWith("taoffice");
    expect(onOpenWith).toHaveBeenCalledWith("taoffice");
  });
});

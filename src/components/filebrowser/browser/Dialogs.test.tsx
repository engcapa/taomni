import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import type { FileEntry } from "../../../lib/sftp";
import { DownloadPrompt, PreviewModal } from "./Dialogs";

const sampleEntry: FileEntry = {
  name: "report.log",
  path: "/var/log/report.log",
  size: 128,
  mtime: 0,
  mode: 0o644,
  fileType: "file",
  isHidden: false,
};

afterEach(cleanup);

beforeEach(() => {
  setLocale("en");
});

describe("FileBrowser modal dialogs", () => {
  it("focuses primary action, wraps Tab, guards IME Esc, and returns focus for DownloadPrompt", async () => {
    const onCancel = vi.fn();
    const onDownload = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <DownloadPrompt
              entry={sampleEntry}
              localDir="/tmp/downloads"
              onCancel={() => {
                onCancel();
                setOpen(false);
              }}
              onDownload={onDownload}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId("sftp-download-prompt");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const openBtn = screen.getByTestId("sftp-download-prompt-open");
    const closeIcon = screen.getByLabelText("Close");
    expect(openBtn).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(closeIcon).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(openBtn).toHaveFocus();

    fireEvent.click(screen.getByTestId("sftp-download-prompt-download"));
    expect(onDownload).toHaveBeenCalledWith(false);
    fireEvent.click(openBtn);
    expect(onDownload).toHaveBeenCalledWith(true);

    fireEvent.keyDown(dialog, { key: "Escape", keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("sftp-download-prompt")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("renders PreviewModal on the complex surface and closes on backdrop pointer-up or Esc", async () => {
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="preview-opener" onClick={() => setOpen(true)}>
            Preview
          </button>
          {open && (
            <PreviewModal
              path="/var/log/report.log"
              name="report.log"
              text="line-1\nline-2"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByTestId("preview-opener");
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId("sftp-preview-modal");
    expect(dialog).toHaveAttribute("data-size", "complex");
    expect(screen.getByTestId("sftp-preview-close")).toHaveFocus();
    expect(screen.getByText(/line-1/)).toBeInTheDocument();

    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 100, right: 500, bottom: 500 }),
    });
    fireEvent.pointerDown(dialog, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(dialog, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

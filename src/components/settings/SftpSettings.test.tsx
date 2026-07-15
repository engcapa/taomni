import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SftpSettings } from "./SftpSettings";
import {
  loadSftpPreferences,
  SFTP_PREFERENCES_STORAGE_KEY,
} from "../../lib/sftpPreferences";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SftpSettings", () => {
  it("renders with open selected by default and can switch to upload", () => {
    render(<SftpSettings />);

    const openBtn = screen.getByTestId("sftp-local-double-click-open");
    const uploadBtn = screen.getByTestId("sftp-local-double-click-upload");

    expect(openBtn).toHaveAttribute("aria-checked", "true");
    expect(uploadBtn).toHaveAttribute("aria-checked", "false");

    fireEvent.click(uploadBtn);

    expect(uploadBtn).toHaveAttribute("aria-checked", "true");
    expect(openBtn).toHaveAttribute("aria-checked", "false");
    expect(loadSftpPreferences().localDoubleClickAction).toBe("upload");
    expect(JSON.parse(localStorage.getItem(SFTP_PREFERENCES_STORAGE_KEY) ?? "{}"))
      .toEqual({ localDoubleClickAction: "upload" });
  });

  it("resets to default open action", () => {
    localStorage.setItem(
      SFTP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ localDoubleClickAction: "upload" }),
    );
    render(<SftpSettings />);

    expect(screen.getByTestId("sftp-local-double-click-upload"))
      .toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByTestId("sftp-settings-reset"));

    expect(screen.getByTestId("sftp-local-double-click-open"))
      .toHaveAttribute("aria-checked", "true");
    expect(loadSftpPreferences().localDoubleClickAction).toBe("open");
  });
});

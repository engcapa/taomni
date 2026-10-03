import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../lib/i18n";
import {
  DEFAULT_SQL_COMPLETION_PREFERENCES,
  SQL_COMPLETION_PREFERENCES_STORAGE_KEY,
} from "../../lib/sqlCompletionPreferences";
import { SqlCompletionSettings } from "./SqlCompletionSettings";

function storedPreferences() {
  return JSON.parse(localStorage.getItem(SQL_COMPLETION_PREFERENCES_STORAGE_KEY) ?? "null");
}

describe("SqlCompletionSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
  });

  afterEach(() => {
    cleanup();
  });

  it("records and persists completion behavior", async () => {
    const user = userEvent.setup();
    render(<SqlCompletionSettings />);

    const shortcut = screen.getByTestId("sql-completion-trigger-shortcut");
    expect(shortcut).toHaveValue("Ctrl+Space");
    await user.click(screen.getByTestId("sql-completion-activate-on-typing"));
    fireEvent.keyDown(shortcut, { key: "i", code: "KeyI", altKey: true });
    await user.click(screen.getByTestId("sql-completion-accept-enter"));

    expect(shortcut).toHaveValue("Alt+I");
    expect(storedPreferences()).toEqual({
      activateOnTyping: false,
      triggerShortcut: "Alt-i",
      acceptWithTab: true,
      acceptWithEnter: false,
    });
  });

  it("rejects SQL editor conflicts without replacing the current shortcut", () => {
    render(<SqlCompletionSettings />);
    const shortcut = screen.getByTestId("sql-completion-trigger-shortcut");

    fireEvent.keyDown(shortcut, { key: "F5", code: "F5" });

    expect(shortcut).toHaveValue("Ctrl+Space");
    expect(screen.getByTestId("sql-completion-shortcut-error"))
      .toHaveTextContent("already used by an SQL editor command");
    expect(localStorage.getItem(SQL_COMPLETION_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("always retains at least one accept key and resets all preferences", async () => {
    const user = userEvent.setup();
    render(<SqlCompletionSettings />);
    const tab = screen.getByTestId("sql-completion-accept-tab");
    const enter = screen.getByTestId("sql-completion-accept-enter");

    await user.click(tab);
    expect(tab).not.toBeChecked();
    expect(enter).toBeChecked();
    expect(enter).toBeDisabled();

    await user.click(screen.getByTestId("sql-completion-reset"));
    expect(tab).toBeChecked();
    expect(enter).toBeChecked();
    expect(storedPreferences()).toEqual(DEFAULT_SQL_COMPLETION_PREFERENCES);
  });
});

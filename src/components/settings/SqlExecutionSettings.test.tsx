import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../lib/i18n";
import {
  DEFAULT_SQL_EXECUTION_PREFERENCES,
  SQL_EXECUTION_PREFERENCES_STORAGE_KEY,
} from "../../lib/sqlExecutionPreferences";
import { SqlExecutionSettings } from "./SqlExecutionSettings";

function storedPreferences() {
  return JSON.parse(localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY) ?? "null");
}

describe("SqlExecutionSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
  });

  afterEach(() => {
    cleanup();
  });

  it("records and persists an execution shortcut", async () => {
    render(<SqlExecutionSettings />);

    const runCurrent = screen.getByTestId("sql-execution-run-current");
    expect(runCurrent).toHaveValue("Ctrl+Shift+Enter");
    fireEvent.keyDown(runCurrent, { key: "e", code: "KeyE", altKey: true });

    expect(runCurrent).toHaveValue("Alt+E");
    expect(storedPreferences()).toEqual({
      ...DEFAULT_SQL_EXECUTION_PREFERENCES,
      runCurrent: "Alt-e",
    });
  });

  it("rejects multi-cursor reserved shortcuts without replacing the current value", () => {
    render(<SqlExecutionSettings />);
    const runAll = screen.getByTestId("sql-execution-run-all");

    fireEvent.keyDown(runAll, {
      key: "ArrowUp",
      code: "ArrowUp",
      shiftKey: true,
      altKey: true,
    });

    expect(runAll).toHaveValue("F5");
    expect(screen.getByTestId("sql-execution-run-all-error"))
      .toHaveTextContent("already used by an SQL editor or completion command");
    expect(localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("rejects conflicts with other execution fields", () => {
    render(<SqlExecutionSettings />);
    const runCurrent = screen.getByTestId("sql-execution-run-current");

    fireEvent.keyDown(runCurrent, { key: "F5", code: "F5" });

    expect(runCurrent).toHaveValue("Ctrl+Shift+Enter");
    expect(screen.getByTestId("sql-execution-run-current-error"))
      .toHaveTextContent("conflicts with");
    expect(localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("resets all execution shortcuts", async () => {
    const user = userEvent.setup();
    render(<SqlExecutionSettings />);
    const runAll = screen.getByTestId("sql-execution-run-all");
    fireEvent.keyDown(runAll, { key: "F8", code: "F8" });
    expect(runAll).toHaveValue("F8");

    await user.click(screen.getByTestId("sql-execution-reset"));
    expect(runAll).toHaveValue("F5");
    expect(storedPreferences()).toEqual(DEFAULT_SQL_EXECUTION_PREFERENCES);
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppDialogProvider,
  alertAppDialog,
  choiceAppDialog,
  confirmAppDialog,
  promptAppDialog,
} from "./appDialogs";

describe("appDialogs", () => {
  afterEach(() => {
    cleanup();
  });

  it("resolves confirm dialogs through the app modal host", async () => {
    let result: boolean | undefined;
    render(
      <AppDialogProvider>
        <button
          type="button"
          onClick={() => {
            void confirmAppDialog({ message: "Delete remote entry?", danger: true }).then((value) => {
              result = value;
            });
          }}
        >
          Open
        </button>
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("Delete remote entry?");

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("lets app prompt replacements confirm an empty string", async () => {
    let result: string | null | undefined;
    render(
      <AppDialogProvider>
        <button
          type="button"
          onClick={() => {
            void promptAppDialog({
              title: "Set terminal title",
              initialValue: "shell",
              allowEmpty: true,
            }).then((value) => {
              result = value;
            });
          }}
        >
          Rename
        </button>
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByText("Rename"));
    const input = screen.getByTestId("text-input-dialog-input");
    fireEvent.change(input, { target: { value: "" } });

    expect(screen.getByTestId("text-input-dialog-confirm")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    await waitFor(() => expect(result).toBe(""));
  });

  it("resolves choice dialogs through the app modal host", async () => {
    let result: "primary" | "secondary" | null | undefined;
    render(
      <AppDialogProvider>
        <button
          type="button"
          onClick={() => {
            void choiceAppDialog({
              title: "Confirm Commit and Push",
              message: "Commit two repositories?",
              primaryLabel: "Commit and Push",
              secondaryLabel: "Commit only",
            }).then((value) => {
              result = value;
            });
          }}
        >
          Choose
        </button>
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByText("Choose"));
    expect(screen.getByTestId("choice-dialog-message")).toHaveTextContent("Commit two repositories?");

    fireEvent.click(screen.getByTestId("choice-dialog-secondary"));
    await waitFor(() => expect(result).toBe("secondary"));
    expect(screen.queryByTestId("choice-dialog")).not.toBeInTheDocument();
  });

  it("resolves alert dialogs without using browser alerts", async () => {
    let closed = false;
    render(
      <AppDialogProvider>
        <button
          type="button"
          onClick={() => {
            void alertAppDialog({ title: "Export failed", message: "Permission denied" }).then(() => {
              closed = true;
            });
          }}
        >
          Alert
        </button>
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByText("Alert"));
    expect(screen.getByTestId("alert-dialog-message")).toHaveTextContent("Permission denied");

    fireEvent.click(screen.getByTestId("alert-dialog-ok"));
    await waitFor(() => expect(closed).toBe(true));
    expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
  });
});

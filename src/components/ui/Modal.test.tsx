import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog, TextInputDialog } from "../sidebar/ConfirmDialog";

afterEach(cleanup);

it("focuses Cancel for destructive decisions and traps focus until Escape", () => {
  const cancel = vi.fn();
  const confirm = vi.fn();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const view = render(<ConfirmDialog title="Delete" message="Delete this item?"
    danger onCancel={cancel} onConfirm={confirm} />);
  const first = screen.getByTestId("confirm-dialog-cancel");
  const last = screen.getByTestId("confirm-dialog-confirm");
  expect(screen.getByRole("dialog", { name: "Delete" })).toHaveAccessibleDescription("Delete this item?");
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Escape", isComposing: true });
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.keyDown(first, { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  view.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it("lets the input method finish before submitting a prompt", () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  render(<TextInputDialog title="Rename" onConfirm={confirm} onCancel={cancel} />);
  const input = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.change(input, { target: { value: "文件" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
  expect(confirm).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(confirm).toHaveBeenCalledExactlyOnceWith("文件");
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ThemedSelect } from "../ThemedSelect";
import { Modal } from "./Modal";
import { ModalSurface } from "./ModalSurface";
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

it("keeps an owned listbox inside the top layer and dismisses one layer per Escape", () => {
  const cancel = vi.fn();
  function Fixture() {
    const [value, setValue] = useState("a");
    return <Modal title="Options" testId="options" initialFocus="button" onCancel={cancel} footer={null}>
      <ThemedSelect label="Choice" value={value} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={setValue} />
    </Modal>;
  }
  render(<Fixture />);
  const trigger = screen.getByRole("combobox");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("listbox"));
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("light dismisses only when the same pointer starts and ends on the backdrop", () => {
  const cancel = vi.fn();
  const view = (light: boolean) => <Modal title="Session information" testId="info" initialFocus="button"
    dismissOnBackdrop={light} onCancel={cancel} footer={<button type="button">Close</button>}>
    <p>Connected desktop</p>
  </Modal>;
  const component = render(view(true));
  const panel = screen.getByRole("dialog");
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 240));
  const outside = { pointerId: 7, button: 0, clientX: 20, clientY: 20 };
  fireEvent.pointerDown(screen.getByText("Connected desktop"), outside);
  fireEvent.pointerUp(panel, outside);
  fireEvent.pointerDown(panel, { ...outside, clientX: 130, clientY: 125 });
  fireEvent.pointerUp(panel, outside);
  fireEvent.pointerDown(panel, outside);
  fireEvent.pointerCancel(panel, outside);
  fireEvent.pointerUp(panel, outside);
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.pointerDown(panel, outside);
  fireEvent.pointerUp(panel, outside);
  expect(cancel).toHaveBeenCalledTimes(1);
  component.rerender(view(false));
  fireEvent.pointerDown(panel, outside);
  fireEvent.pointerUp(panel, outside);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("routes window-level Escape only to the topmost open modal and ignores IME composition", () => {
  const outerCancel = vi.fn();
  const innerCancel = vi.fn();
  render(
    <>
      <Modal title="Outer" testId="outer" initialFocus="button" onCancel={outerCancel}
        footer={<button type="button">Outer close</button>}>
        <p>Outer body</p>
      </Modal>
      <Modal title="Inner" testId="inner" initialFocus="button" onCancel={innerCancel}
        footer={<button type="button">Inner close</button>}>
        <p>Inner body</p>
      </Modal>
    </>,
  );

  fireEvent.keyDown(window, { key: "Escape", isComposing: true });
  expect(innerCancel).not.toHaveBeenCalled();
  expect(outerCancel).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(innerCancel).toHaveBeenCalledTimes(1);
  expect(outerCancel).not.toHaveBeenCalled();
});

it("composes custom onKeyDown shortcuts on ModalSurface while preserving Escape and Tab handling", () => {
  const cancel = vi.fn();
  const shortcut = vi.fn();
  render(
    <ModalSurface
      aria-label="Custom shortcuts"
      initialFocus="input"
      onCancel={cancel}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          shortcut();
        }
      }}
    >
      <input type="text" aria-label="Search" />
      <button type="button">Done</button>
    </ModalSurface>,
  );
  const input = screen.getByRole("textbox", { name: "Search" });
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "f", ctrlKey: true });
  expect(shortcut).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(1);
});

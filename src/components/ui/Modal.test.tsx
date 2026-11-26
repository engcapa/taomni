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

it("supports dismissOnBackdrop, window Tab wrapping, and ignores hidden menus during window Escape on ModalSurface", () => {
  const cancel = vi.fn();
  render(
    <>
      <div data-taomni-context-menu="" hidden style={{ display: "none" }} />
      <ModalSurface
        aria-label="Direct modal surface"
        initialFocus='[data-testid="ms-first"]'
        dismissOnBackdrop
        onCancel={cancel}
      >
        <button type="button" data-testid="ms-first">First</button>
        <button type="button" data-testid="ms-last">Last</button>
      </ModalSurface>
    </>,
  );

  const panel = screen.getByRole("dialog", { name: "Direct modal surface" });
  const first = screen.getByTestId("ms-first");
  const last = screen.getByTestId("ms-last");
  expect(first).toHaveFocus();

  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(first).toHaveFocus();

  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 300, 200));
  fireEvent.pointerDown(panel, { pointerId: 2, button: 0, clientX: 120, clientY: 120 });
  fireEvent.pointerUp(panel, { pointerId: 2, button: 0, clientX: 20, clientY: 20 });
  expect(cancel).not.toHaveBeenCalled();

  fireEvent.pointerDown(panel, { pointerId: 3, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerUp(panel, { pointerId: 3, button: 0, clientX: 20, clientY: 20 });
  expect(cancel).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("restores explicit returnFocus even when native dialog.close focuses the pre-modal active element", () => {
  const showDesc = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  const closeDesc = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
  const preOpenEl = document.createElement("div");
  preOpenEl.tabIndex = 0;
  const explicitTrigger = document.createElement("button");
  explicitTrigger.type = "button";
  document.body.append(preOpenEl, explicitTrigger);

  let dialogSavedOpener: Element | null = null;
  HTMLDialogElement.prototype.showModal = function () {
    dialogSavedOpener = document.activeElement;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    if (dialogSavedOpener instanceof HTMLElement) dialogSavedOpener.focus();
  };

  try {
    preOpenEl.focus();
    expect(preOpenEl).toHaveFocus();
    const view = render(
      <ModalSurface
        aria-label="Explicit return focus"
        initialFocus='[data-testid="erf-btn"]'
        returnFocus={explicitTrigger}
        onCancel={vi.fn()}
      >
        <button type="button" data-testid="erf-btn">Inside</button>
      </ModalSurface>,
    );
    expect(screen.getByTestId("erf-btn")).toHaveFocus();
    view.unmount();
    expect(explicitTrigger).toHaveFocus();
    expect(preOpenEl).not.toHaveFocus();
  } finally {
    if (showDesc) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showDesc);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    if (closeDesc) Object.defineProperty(HTMLDialogElement.prototype, "close", closeDesc);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
    preOpenEl.remove();
    explicitTrigger.remove();
  }
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWindowDrag } from "./windowDrag";

const calls = vi.hoisted(() => ({ startDragging: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => calls }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderTitleBar() {
  return render(
    <div data-window-drag onMouseDown={startWindowDrag}>
      <span data-testid="title">Title</span>
      <button data-testid="button"><svg data-testid="button-icon" /></button>
      <div role="tab" data-testid="tab"><span data-testid="tab-title">Tab</span></div>
      <a href="#" data-testid="link">Link</a>
      <input data-testid="input" />
      <div contentEditable suppressContentEditableWarning data-testid="editable">Draft</div>
      <div draggable data-testid="draggable">Drag item</div>
      <div data-window-drag="false" data-testid="opt-out">Custom control</div>
      <div onMouseDown={(event) => event.preventDefault()} data-testid="handled">Handled</div>
      {createPortal(<div data-window-drag data-testid="popup">Popup</div>, document.body)}
    </div>,
  );
}

describe("shared title-bar gesture routing", () => {
  it("moves and maximizes from background descendants exactly once", () => {
    renderTitleBar();
    fireEvent.mouseDown(screen.getByTestId("title"), { button: 0, detail: 1 });
    fireEvent.mouseDown(screen.getByTestId("title"), { button: 0, detail: 2 });
    fireEvent.mouseDown(screen.getByTestId("title"), { button: 1 });
    fireEvent.mouseDown(screen.getByTestId("title"), { button: 2 });
    expect(calls.startDragging).toHaveBeenCalledTimes(1);
    expect(calls.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it.each(["button", "button-icon", "tab-title", "link", "input", "editable", "draggable", "opt-out", "handled", "popup"])(
    "leaves %s input to its owner", (id) => {
      renderTitleBar();
      fireEvent.mouseDown(screen.getByTestId(id), { button: 0, detail: 1 });
      fireEvent.mouseDown(screen.getByTestId(id), { button: 0, detail: 2 });
      expect(calls.startDragging).not.toHaveBeenCalled();
      expect(calls.toggleMaximize).not.toHaveBeenCalled();
    },
  );
});

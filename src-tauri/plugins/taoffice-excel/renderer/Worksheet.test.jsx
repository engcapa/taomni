import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

let Worksheet;
beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ Worksheet } = await import("./Worksheet.jsx"));
  vi.unstubAllGlobals();
});
afterEach(cleanup);

function mount(permitted = true) {
  const apply = vi.fn(() => true);
  const range = { start: { row: 0, column: 0 }, sheet: "Orders", window: { rows: 3, columns: 3, cells: [
    { row: 0, column: 0, value: "Keyboard", editType: "string" },
    { row: 1, column: 0, value: "12", editType: "number" },
    { row: 1, column: 1, value: "24", formula: "A2*2" },
  ] } };
  function Grid() {
    const [cursor, move] = React.useState(range.start);
    return <Worksheet range={range} cursor={cursor} move={move} active pending={false}
      label={(_, en) => en} platform="windows" editor={{ permitted, edits: new Map(), apply }} />;
  }
  render(<Grid />);
  return apply;
}

function cell(address) {
  return screen.getAllByRole("gridcell").find(el => el.dataset.address === address);
}

it("edits in the selected cell and commits vertically or horizontally with modifiers", () => {
  const apply = mount();
  fireEvent.keyDown(cell("A1"), { key: "F2" });
  let input = screen.getByRole("textbox", { name: "Edit cell A1" });
  expect(input.closest("td")).toBe(cell("A1"));
  expect([input.selectionStart, input.selectionEnd]).toEqual([8, 8]);
  fireEvent.change(input, { target: { value: "Keys" } });
  expect(screen.getByTestId("taoffice-excel-formula").value).toBe("Keys");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(apply).toHaveBeenCalledWith("Orders", "A1", "Keyboard", "Keys");
  expect(document.activeElement).toBe(cell("A2"));
  fireEvent.doubleClick(cell("A2"));
  input = screen.getByRole("textbox", { name: "Edit cell A2" });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(document.activeElement).toBe(cell("B2"));
  fireEvent.keyDown(cell("B2"), { key: "ArrowLeft" });
  fireEvent.keyDown(cell("A2"), { key: "F2" });
  fireEvent.keyDown(screen.getByTestId("taoffice-excel-input"), { key: "Enter", shiftKey: true });
  expect(document.activeElement).toBe(cell("A1"));
});

it("keeps caret, draft and selection owned by the editor while composing or invalid", () => {
  const apply = mount();
  fireEvent.keyDown(cell("A1"), { key: "ArrowDown" });
  fireEvent.doubleClick(cell("A2"));
  const input = screen.getByTestId("taoffice-excel-input");
  fireEvent.change(input, { target: { value: "Invalid" } });
  for (const key of ["Escape", "Enter", "Tab", "ArrowRight"]) {
    fireEvent.keyDown(input, { key, keyCode: 229 });
    expect(document.activeElement).toBe(input);
  }
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.blur(input);
  fireEvent.click(cell("B2"));
  expect(screen.getByTestId("taoffice-excel-input").value).toBe("Invalid");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(document.activeElement).toBe(cell("A2"));
  expect(apply).not.toHaveBeenCalled();
});

it("navigates a read-only workbook and ignores double-click and F2 on protected cells", () => {
  mount(false);
  fireEvent.keyDown(cell("A1"), { key: "Enter" });
  fireEvent.keyDown(cell("A2"), { key: "ArrowRight" });
  expect(document.activeElement).toBe(cell("B2"));
  fireEvent.doubleClick(cell("B2"));
  fireEvent.keyDown(cell("B2"), { key: "F2" });
  expect(screen.queryByTestId("taoffice-excel-input")).toBeNull();
  expect(screen.getByTestId("taoffice-excel-formula").value).toBe("=A2*2");
});

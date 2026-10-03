import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineRenamePopup, type InlineRenamePopupProps } from "./InlineRenamePopup";

function setup(overrides: Partial<InlineRenamePopupProps> = {}) {
  const props: InlineRenamePopupProps = {
    kind: "rename",
    anchor: { left: 10, top: 10, height: 16, fontFamily: "monospace", fontSize: "13px" },
    initialValue: "stringArrayList",
    suggestions: ["stringArrayList", "arrayList", "list"],
    validate: (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? null : `'${name}' is not a valid identifier`),
    modalOptions: false,
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onOpenDialog: vi.fn(),
    onToggleModalOptions: vi.fn(),
    ...overrides,
  };
  render(<InlineRenamePopup {...props} />);
  return { props, input: screen.getByTestId("code-workspace-inline-rename-input") as HTMLInputElement };
}

describe("ED-PARITY-017 InlineRenamePopup", () => {
  afterEach(() => cleanup());

  it("focuses the selected name and shows suggestions with the IDEA hint", () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("stringArrayList".length);
    expect(screen.getAllByTestId("code-workspace-inline-rename-suggestion").map((item) => item.textContent))
      .toEqual(["stringArrayList", "arrayList", "list"]);
    expect(screen.getByTestId("code-workspace-inline-rename-hint").textContent).toContain("Shift+F6");
  });

  it("first Escape closes the list, the second cancels", () => {
    const { input, props } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByTestId("code-workspace-inline-rename").dataset.listOpen).toBe("false");
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("arrows pick suggestions and Enter commits the picked name", () => {
    const { input, props } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("arrayList");
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommit).toHaveBeenCalledWith("arrayList");
  });

  it("keeps the session with an inline error for an invalid name", () => {
    const { input, props } = setup();
    fireEvent.change(input, { target: { value: "9x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("code-workspace-inline-rename-error").textContent).toContain("not a valid identifier");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("Shift+F6 opens the dialog with the typed value; Alt+Shift+O shows options", () => {
    const { input, props } = setup();
    fireEvent.change(input, { target: { value: "items" } });
    fireEvent.keyDown(input, { key: "O", code: "KeyO", altKey: true, shiftKey: true });
    const options = screen.getByTestId("code-workspace-inline-rename-options");
    expect((screen.getByTestId("code-workspace-inline-rename-option-comments") as HTMLInputElement).disabled).toBe(true);
    expect(options.textContent).toContain("Not supported by the language server rename");
    fireEvent.click(screen.getByTestId("code-workspace-inline-rename-option-modal"));
    expect(props.onToggleModalOptions).toHaveBeenCalledWith(true);
    fireEvent.keyDown(input, { key: "F6", shiftKey: true });
    expect(props.onOpenDialog).toHaveBeenCalledWith("items");
  });

  it("a press outside ends the session as a cancel", () => {
    const { props } = setup();
    fireEvent.mouseDown(document.body);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

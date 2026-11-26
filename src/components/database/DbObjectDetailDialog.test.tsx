import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbObjectDetailDialog } from "./DbObjectDetailDialog";

vi.mock("../../lib/clipboard", () => ({ writeText: vi.fn(async () => undefined) }));

afterEach(cleanup);

describe("DbObjectDetailDialog", () => {
  it("renders DDL inside top-layer dialog, guards IME Escape, dismisses on backdrop/Escape, and restores opener focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();

    const view = render(
      <DbObjectDetailDialog
        detail={{ kind: "ddl", title: "orders DDL", sql: "CREATE TABLE orders (id INT);" }}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByTestId("db-object-detail-dialog");
    expect(dialog.tagName).toBe("DIALOG");
    expect(screen.getByTestId("db-object-detail-close")).toHaveFocus();
    expect(dialog).toHaveTextContent("CREATE TABLE orders (id INT);");

    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 500, 400));
    fireEvent.pointerDown(dialog, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(dialog, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

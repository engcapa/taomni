import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickDocPopup } from "./QuickDocPopup";

describe("QuickDocPopup", () => {
  it("renders markdown body and supports pin / close / Escape", () => {
    const onClose = vi.fn();
    const onPin = vi.fn();
    render(
      <QuickDocPopup
        open
        content={{ title: "openFile", body: "**Opens** a file." }}
        onClose={onClose}
        onPin={onPin}
      />,
    );

    expect(screen.getByTestId("code-workspace-quick-doc")).toBeInTheDocument();
    expect(screen.getByText("openFile")).toBeInTheDocument();
    expect(screen.getByText("Opens")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(onPin).toHaveBeenCalledWith({ title: "openFile", body: "**Opens** a file." });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("hides when closed", () => {
    const { container } = render(
      <QuickDocPopup
        open={false}
        content={{ title: "x", body: "y" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

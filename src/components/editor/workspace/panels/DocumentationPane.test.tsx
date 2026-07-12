import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentationPane } from "./DocumentationPane";

describe("DocumentationPane", () => {
  it("shows empty guidance when nothing is pinned", () => {
    render(<DocumentationPane content={null} />);
    expect(screen.getByTestId("code-workspace-documentation-pane")).toHaveTextContent(
      /No pinned documentation/,
    );
  });

  it("renders pinned content and clear/unpin actions", () => {
    const onClear = vi.fn();
    const onUnlock = vi.fn();
    render(
      <DocumentationPane
        content={{ title: "CodeWorkspaceTab", body: "Main shell component." }}
        locked
        onClear={onClear}
        onUnlock={onUnlock}
      />,
    );
    expect(screen.getByText("CodeWorkspaceTab")).toBeInTheDocument();
    expect(screen.getByText("Main shell component.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear documentation" }));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unpin documentation" }));
    expect(onUnlock).toHaveBeenCalled();
  });
});

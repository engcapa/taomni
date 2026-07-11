import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListTree } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomDock } from "./BottomDock";

const tabs = [
  {
    id: "references",
    label: "References",
    icon: <ListTree aria-hidden="true" />,
    badge: 3,
    content: <div>Reference results</div>,
  },
];

describe("BottomDock", () => {
  afterEach(() => cleanup());

  it("renders the active tab content and collapses it from the tab", () => {
    const onOpenChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        onOpenChange={onOpenChange}
        onActiveTabChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("tabpanel", { name: "References" })).toHaveTextContent("Reference results");
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /References/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("activates and expands a closed tab", () => {
    const onOpenChange = vi.fn();
    const onActiveTabChange = vi.fn();
    render(
      <BottomDock
        open={false}
        activeTab="references"
        tabs={tabs}
        onOpenChange={onOpenChange}
        onActiveTabChange={onActiveTabChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /References/ }));
    expect(onActiveTabChange).toHaveBeenCalledWith("references");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

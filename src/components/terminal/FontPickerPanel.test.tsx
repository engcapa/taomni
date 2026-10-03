import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontPickerSelect, type FontPickerOption } from "./FontPickerPanel";

function makeOptions(count: number): FontPickerOption[] {
  return Array.from({ length: count }, (_, index) => ({
    value: `Font ${String(index).padStart(3, "0")}`,
    label: `Font ${String(index).padStart(3, "0")}`,
    fontFamily: `"Font ${index}", monospace`,
  }));
}

describe("FontPickerSelect", () => {
  afterEach(() => {
    cleanup();
  });

  it("defers grouping until opened and only mounts a window of a large catalog", async () => {
    const user = userEvent.setup();
    const groupForOption = vi.fn(() => "fonts");
    render(
      <FontPickerSelect
        ariaLabel="Test font"
        options={makeOptions(500)}
        selectedValue="Font 000"
        onSelect={vi.fn()}
        groupForOption={groupForOption}
        groupLabels={{ fonts: "Fonts" }}
      />,
    );

    expect(groupForOption).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "Test font" }));

    const listbox = await screen.findByRole("listbox");
    expect(groupForOption).toHaveBeenCalledTimes(500);
    expect(within(listbox).getAllByRole("option").length).toBeLessThan(30);
  });

  it("searches the full catalog and selects an initially unmounted option", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <FontPickerSelect
        ariaLabel="Test font"
        options={makeOptions(500)}
        selectedValue="Font 000"
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Test font" }));
    expect(screen.queryByRole("option", { name: "Font 499" })).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "Font 499");
    await user.click(await screen.findByRole("option", { name: "Font 499" }));

    expect(onSelect).toHaveBeenCalledWith("Font 499");
  });
});

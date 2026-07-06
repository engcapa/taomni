import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { NotesSelect } from "./NotesSelect";

describe("NotesSelect", () => {
  const options = [
    { value: "a", label: "Option A" },
    { value: "b", label: "Option B" },
  ];

  afterEach(() => {
    cleanup();
  });

  it("renders the selected option label", () => {
    render(
      <NotesSelect
        value="a"
        options={options}
        onChange={() => {}}
        ariaLabel="Select Option"
      />
    );
    expect(screen.getByText("Option A")).toBeInTheDocument();
  });

  it("toggles the dropdown menu on click", () => {
    render(
      <NotesSelect
        value="a"
        options={options}
        onChange={() => {}}
        ariaLabel="Select Option"
        testId="custom-select-toggle"
      />
    );
    
    // Menu is closed initially
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Click button to open
    fireEvent.click(screen.getByTestId("custom-select-toggle"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();

    // Click again to close
    fireEvent.click(screen.getByTestId("custom-select-toggle"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("calls onChange when an option is selected", () => {
    const handleChange = vi.fn();
    render(
      <NotesSelect
        value="a"
        options={options}
        onChange={handleChange}
        ariaLabel="Select Option"
        testId="custom-select-change"
      />
    );

    // Open dropdown
    fireEvent.click(screen.getByTestId("custom-select-change"));

    // Click Option B
    fireEvent.click(screen.getByText("Option B"));

    expect(handleChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

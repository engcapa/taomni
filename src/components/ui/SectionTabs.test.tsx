import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SectionTabs, sectionTab } from "./SectionTabs";

afterEach(cleanup);

it("keeps one tab stop, wraps around disabled tabs and leaves modified keys with their owner", () => {
  const activate = vi.fn();
  function Example() {
    const [current, setCurrent] = useState("First");
    return <SectionTabs aria-label="Sections">
      {["First", "Disabled", "Last"].map(name =>
        <button key={name} type="button" disabled={name === "Disabled"} {...sectionTab(name === current)}
          onClick={() => { activate(name); setCurrent(name); }}>{name}</button>)}
    </SectionTabs>;
  }
  render(<Example />);
  const first = screen.getByRole("tab", { name: "First" });
  const last = screen.getByRole("tab", { name: "Last" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowRight", ctrlKey: true });
  fireEvent.keyDown(first, { key: "End", isComposing: true });
  expect(activate).not.toHaveBeenCalled();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(last).toHaveFocus();
  expect(last.tabIndex).toBe(0);
  expect(first.tabIndex).toBe(-1);
  fireEvent.keyDown(last, { key: "End" });
  expect(activate).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(last, { key: "ArrowRight" });
  expect(first).toHaveFocus();
  expect(first).toHaveAttribute("aria-selected", "true");
});

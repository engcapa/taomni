import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

let SlideNavigation;
let observer;
beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ SlideNavigation } = await import("./SlideNavigation.jsx"));
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(callback) { this.notify = callback; observer = this; }
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  delete HTMLElement.prototype.scrollIntoView;
  vi.unstubAllGlobals();
});

const names = ["Overview", "Delivery", "Review", "Appendix"];
function Navigation({ active = true, observe = vi.fn() }) {
  const [selected, select] = React.useState(0);
  return <SlideNavigation titles={names} selected={selected} thumbnails={new Map([[1, "blob:delivery"]])}
    width={960} height={540} active={active} select={select} observe={observe} label={(_zh, en) => en} />;
}

it("keeps one tab stop and moves selection, focus and scroll together", () => {
  render(<Navigation />);
  const rows = screen.getAllByRole("option");
  expect(rows.map(row => row.tabIndex)).toEqual([0, -1, -1, -1]);
  fireEvent.click(rows[1]);
  expect(rows[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(rows[1], { key: "End" });
  expect(rows[3]).toHaveFocus();
  fireEvent.keyDown(rows[3], { key: "ArrowUp" });
  expect(rows[2]).toHaveFocus();
  fireEvent.keyDown(rows[2], { key: "Home" });
  expect(rows[0]).toHaveFocus();
  fireEvent.keyDown(rows[0], { key: "PageDown" });
  expect(rows[1]).toHaveFocus();
  fireEvent.keyDown(rows[1], { key: "PageUp" });
  fireEvent.keyDown(rows[0], { key: "r" });
  expect(rows[2]).toHaveFocus();
  expect(rows.map(row => row.tabIndex)).toEqual([-1, -1, 0, -1]);
  expect(rows[2].scrollIntoView).toHaveBeenCalled();
});

it("ignores composing, modified and inactive navigation and requests only visible miniature images", () => {
  const observe = vi.fn();
  const view = render(<Navigation observe={observe} />);
  const rows = screen.getAllByRole("option");
  act(() => observer.notify([{ target: rows[1], isIntersecting: true }, { target: rows[2], isIntersecting: false }]));
  expect(observe).toHaveBeenLastCalledWith([1]);
  expect(rows[1].querySelector("img")).toHaveAttribute("src", "blob:delivery");
  for (const event of [{ isComposing: true }, { ctrlKey: true }, { shiftKey: true }]) {
    fireEvent.keyDown(rows[0], { key: "End", ...event });
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
  }
  const current = observer;
  view.rerender(<Navigation active={false} observe={observe} />);
  fireEvent.keyDown(rows[0], { key: "End" });
  expect(rows[0]).toHaveAttribute("aria-selected", "true");
  expect(current.disconnect).toHaveBeenCalled();
  expect(observe).toHaveBeenLastCalledWith([]);
});

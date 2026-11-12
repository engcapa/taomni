import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OverviewSummary } from "./OverviewSummary";

afterEach(cleanup);
it("keeps the newest wrapped terminal output in view without scrolling file previews", () => {
  const { rerender } = render(<OverviewSummary text="first" followLatest />);
  const element = screen.getByTestId("tab-overview-summary");
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 600 });
  rerender(<OverviewSummary text="first\nnewest output" followLatest />);
  expect(element.scrollTop).toBe(600);
  expect(element).toHaveTextContent("newest output");
  rerender(<OverviewSummary text="file beginning\nfile tail" followLatest={false} />);
  expect(element.scrollTop).toBe(0);
});

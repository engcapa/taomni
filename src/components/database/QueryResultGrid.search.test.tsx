import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryResultGrid } from "./QueryResultGrid";
import type { DbQueryResult } from "../../lib/ipc";
import { getAppPlatform } from "../../lib/runtime";

vi.mock("../../lib/runtime", () => ({ isTauriRuntime: () => false, getAppPlatform: vi.fn(() => "linux") }));
vi.mock("../../lib/clipboard", () => ({ writeText: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ dbRewriteResultSql: vi.fn(async () => ({ sql: "select 1", warnings: [] })) }));
afterEach(() => { cleanup(); vi.mocked(getAppPlatform).mockReturnValue("linux"); });

const result: DbQueryResult = {
  columns: [{ name: "name", type: "TEXT" }, { name: "description", type: "TEXT" }],
  rows: [["Ann", "ann again"], ["Bob", null], ["Anne", "other"]],
  rowsAffected: 0, durationMs: 1, warnings: [],
};
const current = () => screen.getByTestId("query-result-grid").querySelector('[data-search-current="true"]');
const searchFor = (text: string) => fireEvent.change(screen.getByLabelText("Search result set"), { target: { value: text } });

it("navigates matching cells in display order, wraps and leaves unrelated rows visible", () => {
  render(<QueryResultGrid result={result} />);
  expect(screen.getByLabelText("Next match")).toBeDisabled();
  searchFor(" ANN ");
  expect(screen.getByTestId("query-result-search-count")).toHaveTextContent("1/3");
  expect(current()).toHaveTextContent("Ann");
  fireEvent.click(screen.getByLabelText("Next match"));
  expect(current()).toHaveTextContent("ann again");
  const input = screen.getByLabelText("Search result set");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(current()).toHaveTextContent("Anne");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(current()).toHaveTextContent("Ann");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(current()).toHaveTextContent("Anne");
  expect(screen.getByText("Bob")).toBeInTheDocument();
  searchFor("missing");
  expect(current()).toBeNull();
  expect(screen.getByTestId("query-result-search-count")).toHaveTextContent("0/0");
  expect(screen.getByLabelText("Previous match")).toBeDisabled();
});

it("scrolls virtual rows into view and resets stale matches when results change", () => {
  const large = { ...result, rows: Array.from({ length: 240 }, (_, i) => [`${i}`, i === 0 || i === 150 || i === 239 ? `target-${i}` : "other"]) };
  const view = render(<QueryResultGrid result={large} />);
  searchFor("target");
  fireEvent.click(screen.getByLabelText("Next match"));
  expect(current()).toHaveTextContent("target-150");
  expect(screen.getByTestId("query-result-grid-scroll").scrollTop).toBeGreaterThan(3000);
  fireEvent.click(screen.getByLabelText("Previous match"));
  expect(current()).toHaveTextContent("target-0");
  expect(screen.getByTestId("query-result-grid-scroll").scrollTop).toBe(0);
  view.rerender(<QueryResultGrid result={result} />);
  expect(screen.getByTestId("query-result-search-count")).toHaveTextContent("0/0");
  expect(screen.getByLabelText("Next match")).toBeDisabled();
});

it("tracks sorting and column filtering while preserving the matched cell identity", () => {
  render(<QueryResultGrid result={result} />);
  searchFor("ann");
  fireEvent.click(screen.getByLabelText("Previous match"));
  expect(current()).toHaveTextContent("Anne");
  fireEvent.click(screen.getByRole("button", { name: "name" }));
  fireEvent.click(screen.getByRole("button", { name: "name" }));
  expect(screen.getByTestId("query-result-search-count")).toHaveTextContent("1/3");
  fireEvent.click(screen.getByLabelText("Filter column name"));
  fireEvent.click(screen.getByLabelText("Select Ann for name"));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByTestId("query-result-search-count")).toHaveTextContent("1/2");
  expect(current()).toHaveTextContent("Ann");
  expect(screen.queryByText("Anne")).not.toBeInTheDocument();
});

it.each(["linux", "macos"] as const)("owns find/navigation in the focused %s result and leaves editable/IME keys alone", (platform) => {
  vi.mocked(getAppPlatform).mockReturnValue(platform);
  render(<><textarea aria-label="SQL editor" /><QueryResultGrid result={result} /><QueryResultGrid result={result} /></>);
  const grids = screen.getAllByTestId("query-result-grid");
  const inputs = screen.getAllByLabelText("Search result set");
  const body = grids[1].querySelector('[data-testid="query-result-grid-scroll"]')!;
  const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(body, { key: "f", ...mod });
  expect(inputs[1]).toHaveFocus();
  fireEvent.change(inputs[1], { target: { value: "ann" } });
  fireEvent.keyDown(inputs[1], { key: "Enter", isComposing: true });
  expect(grids[1].querySelector('[data-testid="query-result-search-count"]')).toHaveTextContent("1/3");
  fireEvent.keyDown(inputs[1], { key: platform === "macos" ? "g" : "F3", ...(platform === "macos" ? mod : {}) });
  expect(grids[1].querySelector('[data-testid="query-result-search-count"]')).toHaveTextContent("2/3");
  expect(grids[0].querySelector('[data-testid="query-result-search-count"]')).toHaveTextContent("0/0");
  const sql = screen.getByLabelText("SQL editor");
  sql.focus(); fireEvent.keyDown(sql, { key: "f", ...mod });
  expect(sql).toHaveFocus();
  fireEvent.doubleClick(grids[1].querySelector('[title="Bob"]')!);
  const cellInput = grids[1].querySelector('[data-testid="query-result-grid-scroll"] input')!;
  fireEvent.keyDown(cellInput, { key: "f", ...mod });
  expect(cellInput).toHaveFocus();
});

it("moves from chart view to table for navigation and Escape clears search and restores grid focus", () => {
  render(<QueryResultGrid result={result} />);
  searchFor("Ann");
  fireEvent.click(screen.getByLabelText("List view"));
  fireEvent.click(screen.getByLabelText("Next match"));
  expect(current()).toHaveTextContent("ann again");
  const input = screen.getByLabelText("Search result set");
  input.focus(); fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("");
  expect(screen.getByTestId("query-result-grid-scroll")).toHaveFocus();
});

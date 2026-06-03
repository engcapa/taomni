import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryResultGrid } from "./QueryResultGrid";
import type { DbQueryResult } from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  readFileBytes: vi.fn(),
  selectFilePath: vi.fn(),
  selectSaveFilePath: vi.fn(),
  temporaryFilePath: vi.fn(),
  writeStreamAbort: vi.fn(),
  writeStreamAppend: vi.fn(),
  writeStreamClose: vi.fn(),
  writeStreamOpen: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => ({
  writeText: vi.fn(),
}));

vi.mock("../../lib/runtime", () => ({
  isTauriRuntime: () => false,
}));

vi.mock("../../lib/sftp", () => ({
  sftpOpenPath: vi.fn(),
}));

function wideResult(): DbQueryResult {
  return {
    columns: Array.from({ length: 12 }, (_, index) => ({
      name: `col_${index + 1}`,
      type: "String",
    })),
    rows: [
      Array.from({ length: 12 }, (_, index) => `value_${index + 1}`),
      Array.from({ length: 12 }, (_, index) => `next_${index + 1}`),
    ],
    rowsAffected: 0,
    durationMs: 12,
    warnings: [],
  };
}

function filterResult(): DbQueryResult {
  return {
    columns: [
      { name: "id", type: "Int" },
      { name: "name", type: "String" },
      { name: "status", type: "String" },
    ],
    rows: [
      ["1", "Ann", "active"],
      ["2", "Anne", "inactive"],
      ["3", "Bob", "active"],
    ],
    rowsAffected: 0,
    durationMs: 8,
    warnings: [],
  };
}

describe("QueryResultGrid", () => {
  it("keeps the table header horizontally synchronized with the body scroll", () => {
    render(<QueryResultGrid result={wideResult()} />);

    const body = screen.getByTestId("query-result-grid-scroll");
    Object.defineProperty(body, "scrollLeft", { configurable: true, value: 240 });
    Object.defineProperty(body, "scrollTop", { configurable: true, value: 0 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 320 });

    fireEvent.scroll(body);

    expect(screen.getByTestId("query-result-grid-header-scroll")).toHaveStyle({
      transform: "translateX(-240px)",
    });
  });

  it("filters a specific column with fuzzy or exact matching", () => {
    render(<QueryResultGrid result={filterResult()} />);

    fireEvent.click(screen.getByLabelText("Filter column name"));
    fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "Ann" } });

    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("Anne")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exact" }));

    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.queryByText("Anne")).not.toBeInTheDocument();
  });
});

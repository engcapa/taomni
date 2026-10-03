import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryResultGrid } from "./QueryResultGrid";
import { dbRewriteResultSql } from "../../lib/ipc";
import type { DbQueryResult } from "../../lib/ipc";
import { writeText } from "../../lib/clipboard";

vi.mock("../../lib/ipc", () => ({
  dbRewriteResultSql: vi.fn(async (request: {
    sourceSql: string;
    resultColumns: string[];
    filters: Array<{
      columnIndex: number;
      text: string;
      mode: "fuzzy" | "exact";
      selectedValues: (string | null)[];
    }>;
    sorts: Array<{ columnIndex: number; dir: "asc" | "desc" }>;
  }) => {
    const quoteColumn = (index: number) => `\`${request.resultColumns[index]}\``;
    const clauses = request.filters.flatMap((filter) => {
      if (filter.selectedValues.length > 0) {
        return filter.selectedValues.map((value) =>
          value === null ? `${quoteColumn(filter.columnIndex)} IS NULL` : `${quoteColumn(filter.columnIndex)} = '${value}'`,
        );
      }
      if (!filter.text) return [];
      return filter.mode === "exact"
        ? [`${quoteColumn(filter.columnIndex)} = '${filter.text}'`]
        : [`CAST(${quoteColumn(filter.columnIndex)} AS CHAR) LIKE '%${filter.text}%' ESCAPE '!'`];
    });
    const orderBy = request.sorts.length > 0
      ? `ORDER BY ${request.sorts.map((sort) => `${quoteColumn(sort.columnIndex)} ${sort.dir.toUpperCase()}`).join(", ")}`
      : "";
    let sql = request.sourceSql.trim().replace(/;$/, "");
    const limitMatch = /\s+limit\b/i.exec(sql);
    const tail = limitMatch ? sql.slice(limitMatch.index).trimStart() : "";
    sql = limitMatch ? sql.slice(0, limitMatch.index).trimEnd() : sql;
    if (clauses.length > 0) {
      sql = /\bwhere\b/i.test(sql) ? `${sql}\n  AND ${clauses.join("\n  AND ")}` : `${sql}\nWHERE ${clauses.join("\n  AND ")}`;
    }
    if (orderBy) sql = `${sql}\n${orderBy}`;
    if (tail) sql = `${sql}\n${tail}`;
    return {
      sql: `${sql};`,
      mode: "inline",
      reason: null,
      warnings: [],
    };
  }),
  readFileBytes: vi.fn(),
  selectFilePath: vi.fn(),
  selectSaveFilePath: vi.fn(),
  temporaryFilePath: vi.fn(),
  writeStreamAbort: vi.fn(),
  writeStreamAppend: vi.fn(),
  writeStreamClose: vi.fn(),
  writeStreamOpen: vi.fn(),
}));

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title?: string; message: string }) => false));

vi.mock("../../lib/appDialogs", () => ({
  alertAppDialog: vi.fn(async () => undefined),
  confirmAppDialog: confirmMock,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

function longTextResult(): DbQueryResult {
  return {
    columns: [
      { name: "id", type: "Int" },
      { name: "payload", type: "Text" },
    ],
    rows: [
      [
        "1",
        "first line\nsecond line with a long value that should stay complete when viewed from the result grid",
      ],
    ],
    rowsAffected: 0,
    durationMs: 5,
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
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const body = within(screen.getByTestId("query-result-grid-scroll"));
    expect(body.getByText("Ann")).toBeInTheDocument();
    expect(body.getByText("Anne")).toBeInTheDocument();
    expect(body.queryByText("Bob")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Filter column name"));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(body.getByText("Ann")).toBeInTheDocument();
    expect(body.queryByText("Anne")).not.toBeInTheDocument();
  });

  it("filters by distinct column values and previews the generated SQL", async () => {
    render(
      <QueryResultGrid
        result={filterResult()}
        sourceSql="select id, name, status from users"
        sqlEngine="MySQL"
      />,
    );

    fireEvent.click(screen.getByLabelText("Filter column status"));

    expect(screen.getByText("Distinct values")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select active for status"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const body = within(screen.getByTestId("query-result-grid-scroll"));
    expect(body.getByText("Ann")).toBeInTheDocument();
    expect(body.getByText("Bob")).toBeInTheDocument();
    expect(body.queryByText("Anne")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("WHERE `status` = 'active'");
    });

    fireEvent.click(screen.getByRole("button", { name: "status" }));
    fireEvent.click(screen.getByRole("button", { name: "status" }));

    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("ORDER BY `status` DESC");
    });
  });

  it("submits local sorting as an explicit query", async () => {
    const onGeneratedSqlQuery = vi.fn();
    render(
      <QueryResultGrid
        result={filterResult()}
        sourceSql="select * from users limit 100"
        sqlEngine="MySQL"
        onGeneratedSqlQuery={onGeneratedSqlQuery}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "status" }));
    fireEvent.click(screen.getByRole("button", { name: "status" }));
    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("ORDER BY `status` DESC");
      expect(screen.getByTestId("query-result-generated-sql-query")).not.toBeDisabled();
    });
    expect(screen.getByTestId("query-result-generated-sql")).not.toHaveTextContent("FROM (");

    fireEvent.click(screen.getByTestId("query-result-generated-sql-query"));

    await waitFor(() => expect(onGeneratedSqlQuery).toHaveBeenCalledWith(
      "select * from users\nORDER BY `status` DESC\nlimit 100;",
      {
        engine: "MySQL",
        sourceSql: "select * from users limit 100",
        resultColumns: ["id", "name", "status"],
        visibleColumnIndexes: [0, 1, 2],
        globalFilterText: "",
        filters: [],
        sorts: [{ columnIndex: 2, dir: "desc" }],
      },
    ));
  });

  it("submits multi-column sorting in the clicked order", async () => {
    const onGeneratedSqlQuery = vi.fn();
    render(
      <QueryResultGrid
        result={filterResult()}
        sourceSql="select * from users limit 100"
        sqlEngine="MySQL"
        onGeneratedSqlQuery={onGeneratedSqlQuery}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "status" }));
    fireEvent.click(screen.getByRole("button", { name: "name" }), { shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("ORDER BY `status` ASC, `name` ASC");
      expect(screen.getByTestId("query-result-generated-sql-query")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("query-result-generated-sql-query"));

    await waitFor(() => expect(onGeneratedSqlQuery).toHaveBeenCalledWith(
      "select * from users\nORDER BY `status` ASC, `name` ASC\nlimit 100;",
      {
        engine: "MySQL",
        sourceSql: "select * from users limit 100",
        resultColumns: ["id", "name", "status"],
        visibleColumnIndexes: [0, 1, 2],
        globalFilterText: "",
        filters: [],
        sorts: [
          { columnIndex: 2, dir: "asc" },
          { columnIndex: 1, dir: "asc" },
        ],
      },
    ));
  });

  it("disables database query when SQL rewrite is unsupported", async () => {
    const onGeneratedSqlQuery = vi.fn();
    vi.mocked(dbRewriteResultSql).mockResolvedValueOnce({
      sql: null,
      mode: "unsupported",
      reason: "ORDER BY contains comments; SQL rewrite is not available without changing original formatting",
      warnings: [],
    });
    render(
      <QueryResultGrid
        result={filterResult()}
        sourceSql="select * from users order by id -- keep\nlimit 100"
        sqlEngine="MySQL"
        onGeneratedSqlQuery={onGeneratedSqlQuery}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "status" }));

    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("ORDER BY contains comments");
      expect(screen.getByTestId("query-result-generated-sql-query")).toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("query-result-generated-sql-query"));
    expect(onGeneratedSqlQuery).not.toHaveBeenCalled();
  });

  it("copies the backend rewritten generated SQL", async () => {
    render(
      <QueryResultGrid
        result={filterResult()}
        sourceSql="select id, name, status from users"
        sqlEngine="MySQL"
      />,
    );

    fireEvent.click(screen.getByLabelText("Filter column status"));
    fireEvent.click(screen.getByLabelText("Select active for status"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(screen.getByTestId("query-result-generated-sql")).toHaveTextContent("WHERE `status` = 'active'");
    });
    fireEvent.click(screen.getByTestId("query-result-generated-sql-copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copiedSql = vi.mocked(writeText).mock.calls.at(-1)?.[0] as string;
    expect(copiedSql).toContain("WHERE `status` = 'active'");
    expect(copiedSql).not.toContain("FROM (");
  });

  it("copies only the rectangular cell block selected with Alt drag", () => {
    render(<QueryResultGrid result={filterResult()} />);

    const grid = screen.getByTestId("query-result-grid-scroll");
    fireEvent.mouseDown(screen.getByTitle("Ann"), { button: 0, altKey: true });
    fireEvent.mouseEnter(screen.getByTitle("inactive"), { buttons: 1, altKey: true });
    fireEvent.mouseUp(document);
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    expect(vi.mocked(writeText)).toHaveBeenLastCalledWith("name\tstatus\nAnn\tactive\nAnne\tinactive");
  });

  it("opens the full cell value with Ctrl+Enter and preserves line breaks", () => {
    const result = longTextResult();
    const value = result.rows[0][1]!;
    render(<QueryResultGrid result={result} />);

    fireEvent.click(screen.getByText(/first line/));
    fireEvent.keyDown(screen.getByTestId("query-result-grid-scroll"), { key: "Enter", ctrlKey: true });

    expect(screen.getByTestId("query-cell-value-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("query-cell-value-text")).toHaveValue(value);
  });

  it("copies the complete cell value from the full value dialog", () => {
    const result = longTextResult();
    const value = result.rows[0][1]!;
    render(<QueryResultGrid result={result} />);

    fireEvent.contextMenu(screen.getByText(/first line/));
    fireEvent.click(screen.getByTestId("context-menu-item-view-full-value"));
    fireEvent.click(screen.getByTestId("query-cell-value-copy"));

    expect(vi.mocked(writeText)).toHaveBeenLastCalledWith(value);
  });
});

describe("QueryResultGrid save preview", () => {
  async function deleteFirstRowAndSubmit(props: Partial<Parameters<typeof QueryResultGrid>[0]>) {
    render(<QueryResultGrid result={filterResult()} {...props} />);
    fireEvent.click(screen.getByTitle("Row 1"));
    fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit grid edits" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    return confirmMock.mock.calls[0][0].message;
  }

  it("previews grid SQL before applying and runs nothing when canceled", async () => {
    const onPreviewChanges = vi.fn(async () => ({ statements: ["DELETE FROM `t` WHERE `id` = '1'"], warning: null }));
    const onCommitChanges = vi.fn(async () => undefined);
    const message = await deleteFirstRowAndSubmit({ onPreviewChanges, onCommitChanges });

    expect(onPreviewChanges).toHaveBeenCalledWith(expect.objectContaining({ counts: { inserted: 0, updated: 0, deleted: 1 } }));
    expect(message).toContain("SQL to execute (1):\nDELETE FROM `t` WHERE `id` = '1';");
    expect(onCommitChanges).not.toHaveBeenCalled();
  });

  it("applies the previewed changes after confirmation", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const onPreviewChanges = vi.fn(async () => ({ statements: ["DELETE FROM t WHERE id = '1'"], warning: "No primary key found" }));
    const onCommitChanges = vi.fn(async () => undefined);
    const message = await deleteFirstRowAndSubmit({ onPreviewChanges, onCommitChanges });

    expect(message).toContain("⚠ No primary key found");
    await waitFor(() => expect(onCommitChanges).toHaveBeenCalledTimes(1));
    expect(onCommitChanges.mock.calls[0]).toEqual([expect.objectContaining({ counts: { inserted: 0, updated: 0, deleted: 1 } })]);
  });

  it("falls back to the count-only message when the preview fails", async () => {
    const onPreviewChanges = vi.fn(async () => {
      throw new Error("not editable");
    });
    const message = await deleteFirstRowAndSubmit({ onPreviewChanges, onCommitChanges: vi.fn(async () => undefined) });
    expect(message).toBe("Apply grid changes to the database?\n\nAdded: 0\nModified: 0\nDeleted: 1");
  });
});

describe("QueryResultGrid sorting and row count", () => {
  const names = () =>
    Array.from(screen.getByTestId("query-result-grid-scroll").querySelectorAll("div.flex.absolute")).map(
      (row) => row.children[2]?.textContent,
    );

  it("cycles sorting ascending, descending, then original order on the client", () => {
    const onRefresh = vi.fn();
    render(<QueryResultGrid result={filterResult()} onRefresh={onRefresh} />);
    expect(names()).toEqual(["Ann", "Anne", "Bob"]);

    fireEvent.click(screen.getByRole("button", { name: "status" }));
    expect(names()).toEqual(["Ann", "Bob", "Anne"]);
    fireEvent.click(screen.getByRole("button", { name: "status" }));
    expect(names()).toEqual(["Anne", "Ann", "Bob"]);
    fireEvent.click(screen.getByRole("button", { name: "status" }));
    expect(names()).toEqual(["Ann", "Anne", "Bob"]);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("shows the filtered row count as shown [total]/columns", () => {
    render(<QueryResultGrid result={filterResult()} />);
    const count = screen.getByTestId("query-result-row-count");
    expect(count).toHaveTextContent("3/3");
    expect(count).toHaveAttribute("data-filtered", "false");

    fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
    fireEvent.change(screen.getByPlaceholderText("Filter rows"), { target: { value: "Ann" } });
    expect(count).toHaveTextContent("2 [3]/3");
    expect(count).toHaveAttribute("data-filtered", "true");

    fireEvent.change(screen.getByPlaceholderText("Filter rows"), { target: { value: "" } });
    expect(count).toHaveTextContent("3/3");
  });
});

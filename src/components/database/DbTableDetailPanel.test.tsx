import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbTableDetailPanel } from "./DbTableDetailPanel";

const ipc = vi.hoisted(() => ({
  dbDescribeTable: vi.fn(async () => [{ name: "id", type: "int", nullable: false, default: null, primaryKey: true }]),
  dbListForeignKeys: vi.fn(async () => [{ name: "fk_users", columns: ["user_id"], referencedSchema: "app", referencedTable: "users", referencedColumns: ["id"] }]),
  dbListIndexes: vi.fn(async () => [{ name: "PRIMARY", columns: ["id"], unique: true }]),
  dbObjectDdl: vi.fn(async () => "CREATE TABLE app.orders (id INT PRIMARY KEY);"),
  dbTableStats: vi.fn(async () => ({ columns: [{ name: "Rows", type: "int" }], rows: [["2"]], rowsAffected: 0, durationMs: 1, warnings: [] })),
  dbExecute: vi.fn(async () => ({ columns: [{ name: "id", type: "int" }], rows: [["1"], ["2"]], rowsAffected: 0, durationMs: 1, warnings: [] })),
}));

vi.mock("../../lib/ipc", () => ipc);
vi.mock("../../lib/clipboard", () => ({ writeText: vi.fn(async () => undefined) }));

afterEach(() => cleanup());

describe("DbTableDetailPanel", () => {
  it("loads DBeaver-style properties and switches to filtered data and diagram tabs", async () => {
    render(<DbTableDetailPanel sessionId="s1" schema="app" table="orders" engine="MySQL" onClose={vi.fn()} />);
    expect(await screen.findByTestId("db-table-detail-panel")).toBeTruthy();
    expect(screen.getByText("CREATE TABLE app.orders (id INT PRIMARY KEY);")).toBeTruthy();
    expect(screen.getByTestId("db-detail-summary")).toHaveTextContent("app");
    fireEvent.click(screen.getByTestId("db-detail-tab-data"));
    expect(await screen.findByTestId("db-detail-data-grid")).toHaveTextContent("1");
    fireEvent.change(screen.getByTestId("db-detail-data-filter"), { target: { value: "2" } });
    expect(screen.getByTestId("db-detail-data-grid")).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("db-detail-tab-diagram"));
    await waitFor(() => expect(screen.getByTestId("db-detail-diagram")).toHaveTextContent("fk_users"));
    expect(ipc.dbExecute).toHaveBeenCalled();
  });
});

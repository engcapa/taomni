import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaTree } from "./SchemaTree";

const ipcMock = vi.hoisted(() => ({
  dbListSchemas: vi.fn(async () => [{ name: "ecommerce" }]),
  dbListTables: vi.fn(async () => [
    { name: "orders", kind: "table", rowCount: 2_800_000 },
    { name: "report_v", kind: "view", rowCount: null },
  ]),
  dbListObjects: vi.fn(async (_s: string, _schema: string | null, kind: string) =>
    kind === "procedure" ? [{ name: "sp_sync", kind: "procedure" }] : [],
  ),
  dbDescribeTable: vi.fn(async () => [
    { name: "id", type: "int", nullable: false, default: null, primaryKey: true },
  ]),
  dbListIndexes: vi.fn(async () => [{ name: "idx_user", columns: ["user_id"], unique: false }]),
}));

const menuRef = vi.hoisted(() => ({ items: [] as Array<{ label: string; danger?: boolean; disabled?: boolean; children?: unknown[] }> }));

vi.mock("../../lib/ipc", () => ipcMock);

vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({
    show: (_e: unknown, items: typeof menuRef.items) => {
      menuRef.items = items;
    },
    render: null,
  }),
}));

function labels(): string[] {
  return menuRef.items.filter((i) => !!i.label).map((i) => i.label);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SchemaTree folder model", () => {
  it("renders engine-specific category folders after expanding a database", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    const db = await screen.findByText("ecommerce");
    fireEvent.click(db);
    // MySQL folders.
    expect(await screen.findByText("Tables")).toBeInTheDocument();
    expect(screen.getByText("Views")).toBeInTheDocument();
    expect(screen.getByText("Procedures")).toBeInTheDocument();
    expect(screen.getByText("Triggers")).toBeInTheDocument();
    expect(screen.getByText("Events")).toBeInTheDocument();
  });

  it("loads tables eagerly and splits them by kind under Tables/Views", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    await waitFor(() => expect(ipcMock.dbListTables).toHaveBeenCalledWith("s1", "ecommerce", null));
    fireEvent.click(await screen.findByText("Tables"));
    expect(await screen.findByText("orders")).toBeInTheDocument();
    // The view is not under Tables.
    expect(screen.queryByText("report_v")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Views"));
    expect(await screen.findByText("report_v")).toBeInTheDocument();
  });

  it("lazily lists routine objects via db_list_objects", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    fireEvent.click(await screen.findByText("Procedures"));
    await waitFor(() =>
      expect(ipcMock.dbListObjects).toHaveBeenCalledWith("s1", "ecommerce", "procedure"),
    );
    expect(await screen.findByText("sp_sync")).toBeInTheDocument();
  });

  it("expands a table to show its columns and indexes", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    fireEvent.click(await screen.findByText("Tables"));
    fireEvent.click(await screen.findByText("orders"));
    await waitFor(() => expect(ipcMock.dbDescribeTable).toHaveBeenCalledWith("s1", "ecommerce", "orders", null));
    expect(await screen.findByText("id")).toBeInTheDocument();
    expect(await screen.findByText("idx_user")).toBeInTheDocument();
  });

  it("only shows Tables/Views folders for Presto", async () => {
    render(<SchemaTree sessionId="s1" engine="Presto" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    expect(await screen.findByText("Tables")).toBeInTheDocument();
    expect(screen.getByText("Views")).toBeInTheDocument();
    expect(screen.queryByText("Procedures")).not.toBeInTheDocument();
    expect(screen.queryByText("Triggers")).not.toBeInTheDocument();
  });
});

describe("SchemaTree context menus", () => {
  it("builds a full table menu with DDL, indexes and destructive items", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    fireEvent.click(await screen.findByText("Tables"));
    fireEvent.contextMenu(await screen.findByText("orders"));
    const items = labels();
    expect(items).toContain("Insert SELECT statement to editor");
    expect(items).toContain("View DDL");
    expect(items).toContain("View indexes");
    expect(items).toContain("Truncate (TRUNCATE)…");
    expect(items).toContain("Drop (DROP)…");
    expect(menuRef.items.find((i) => i.label === "Drop (DROP)…")?.danger).toBe(true);
  });

  it("hides inline edit + indexes for ClickHouse tables", async () => {
    render(<SchemaTree sessionId="s1" engine="ClickHouse" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    fireEvent.click(await screen.findByText("Tables"));
    fireEvent.contextMenu(await screen.findByText("orders"));
    const items = labels();
    expect(items).toContain("Open (browse data)");
    expect(items).not.toContain("Edit table data");
    expect(items).not.toContain("View indexes");
  });

  it("builds a column menu", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.click(await screen.findByText("ecommerce"));
    fireEvent.click(await screen.findByText("Tables"));
    fireEvent.click(await screen.findByText("orders"));
    fireEvent.contextMenu(await screen.findByText("id"));
    const items = labels();
    expect(items).toContain("Copy column name");
    expect(items).toContain("Insert condition expression to editor");
    expect(items).toContain("Drop column…");
  });

  it("disables rename-database for MySQL", async () => {
    render(<SchemaTree sessionId="s1" engine="MySQL" />);
    fireEvent.contextMenu(await screen.findByText("ecommerce"));
    const rename = menuRef.items.find((i) => i.label === "Rename database…");
    expect(rename?.disabled).toBe(true);
    expect(labels()).toContain("New query");
  });
});


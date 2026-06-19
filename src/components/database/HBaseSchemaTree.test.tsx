import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HBaseSchemaTree } from "./HBaseSchemaTree";

const ipcMock = vi.hoisted(() => ({
  hbaseListTables: vi.fn(async () => [{ name: "users" }, { name: "logs" }]),
  hbaseDescribeTable: vi.fn(async () => ({
    name: "users",
    columnFamilies: [{ name: "cf1", attributes: { VERSIONS: "1" } }],
  })),
  hbaseCancel: vi.fn(async () => undefined),
}));

const menuRef = vi.hoisted(() => ({
  items: [] as Array<{
    label: string;
    danger?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    children?: Array<{ label: string; onClick?: () => void }>;
  }>,
}));

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

function item(label: string) {
  return menuRef.items.find((i) => i.label === label);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  menuRef.items = [];
});

describe("HBaseSchemaTree", () => {
  it("loads and lists tables", async () => {
    render(<HBaseSchemaTree sessionId="s1" transport="native" />);
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("logs")).toBeInTheDocument();
  });

  it("offers read + write actions in the table context menu", async () => {
    render(<HBaseSchemaTree sessionId="s1" transport="native" />);
    const row = await screen.findByText("users");
    fireEvent.contextMenu(row);
    const found = labels();
    expect(found).toContain("Open (scan rows)");
    expect(found).toContain("Count rows");
    expect(found).toContain("Enable table");
    expect(found).toContain("Disable table");
    // drop comes from the shared dbObjects namespace
    expect(found.some((l) => l.startsWith("Drop"))).toBe(true);
  });

  it("disables admin actions on the REST transport", async () => {
    render(<HBaseSchemaTree sessionId="s1" transport="rest" />);
    const row = await screen.findByText("users");
    fireEvent.contextMenu(row);
    expect(item("Enable table")?.disabled).toBe(true);
    expect(item("Disable table")?.disabled).toBe(true);
    expect(item("Alter (add/modify family)…")?.disabled).toBe(true);
    // non-admin actions stay enabled
    expect(item("Count rows")?.disabled).toBeFalsy();
  });

  it("runs a scan when Browse is chosen", async () => {
    const onRunCommand = vi.fn();
    render(<HBaseSchemaTree sessionId="s1" transport="native" onRunCommand={onRunCommand} />);
    const row = await screen.findByText("users");
    fireEvent.contextMenu(row);
    item("Open (scan rows)")?.onClick?.();
    expect(onRunCommand).toHaveBeenCalledWith("scan 'users', {LIMIT => 50}");
  });

  it("confirms drop runs through onRunCommand (centralized confirmation)", async () => {
    const onRunCommand = vi.fn();
    render(<HBaseSchemaTree sessionId="s1" transport="native" onRunCommand={onRunCommand} />);
    const row = await screen.findByText("users");
    fireEvent.contextMenu(row);
    const drop = menuRef.items.find((i) => i.label.startsWith("Drop"));
    drop?.onClick?.();
    expect(onRunCommand).toHaveBeenCalledWith("drop 'users'");
  });

  it("expands a table to show its column families", async () => {
    render(<HBaseSchemaTree sessionId="s1" transport="native" />);
    const row = await screen.findByText("users");
    fireEvent.click(row);
    expect(await screen.findByText("cf1")).toBeInTheDocument();
    await waitFor(() => expect(ipcMock.hbaseDescribeTable).toHaveBeenCalled());
  });
});

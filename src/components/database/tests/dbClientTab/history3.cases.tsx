import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { getQueryTab } from "../../../../lib/queryRegistry";
import DbClientTab from "../../DbClientTab";
import { contextMenuShow, dbChildProps, ipcMock, postgresInfo, waitForConnectedEditor } from "./harness";

export function registerDbClientTabHistory3Cases() {

  it("runs the current statement from the Current toolbar button", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    expect(screen.getByTestId("db-run-current-statement")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("db-run-current-statement"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toBe("select 2");
    });
  });

  it("restores a custom query tab name from the workspace", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "named-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "named-panel",
        tabOrder: 0,
        content: "select restored_named",
        filePath: null,
        fileName: null,
        savedQueryId: null,
        displayName: "订单巡检",
        dirty: true,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => {
      expect(screen.getByTestId("db-query-tab")).toHaveTextContent("订单巡检*");
    });
  });

  it("renames a query tab through the inline editor and persists the display name", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();

    fireEvent.doubleClick(screen.getByTestId("db-query-tab"));
    const input = await screen.findByTestId("db-query-tab-input");
    fireEvent.change(input, { target: { value: "订单巡检" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("db-query-tab")).toHaveTextContent("订单巡检");
      expect(screen.queryByTestId("db-query-tab-input")).not.toBeInTheDocument();
    });

    await act(async () => {
      await getQueryTab("tab-1")?.flushWorkspace?.();
    });

    expect(ipcMock.dbSaveQueryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      tabs: [expect.objectContaining({ displayName: "订单巡检" })],
    }));
    expect(ipcMock.dbUpdateHistoryTabName).toHaveBeenCalledWith(
      "saved-pg",
      expect.any(String),
      "订单巡检",
    );
  });

  it("cancels a query tab rename with Escape", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();

    fireEvent.doubleClick(screen.getByTestId("db-query-tab"));
    const input = await screen.findByTestId("db-query-tab-input");
    fireEvent.change(input, { target: { value: "should-be-cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByTestId("db-query-tab")).toHaveTextContent("Query 1");
      expect(screen.queryByTestId("db-query-tab-input")).not.toBeInTheDocument();
    });
    expect(ipcMock.dbUpdateHistoryTabName).not.toHaveBeenCalled();
  });

  it("clears the custom query tab name when the draft is blank", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "named-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "named-panel",
        tabOrder: 0,
        content: "select restored_named",
        filePath: null,
        fileName: null,
        savedQueryId: null,
        displayName: "订单巡检",
        dirty: false,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(screen.getByTestId("db-query-tab")).toHaveTextContent("订单巡检"));

    fireEvent.doubleClick(screen.getByTestId("db-query-tab"));
    const input = await screen.findByTestId("db-query-tab-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("db-query-tab")).toHaveTextContent("Query 1");
    });
    expect(ipcMock.dbUpdateHistoryTabName).toHaveBeenCalledWith("saved-pg", "named-panel", null);
  });

  it("offers Rename tab as the first query tab context menu item", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();

    fireEvent.contextMenu(screen.getByTestId("db-query-tab"));

    type MenuItemStub = { label: string; testId?: string; onClick?: () => void; };
    const menuCalls = contextMenuShow.mock.calls as Array<[unknown, MenuItemStub[]]>;
    const items = menuCalls.at(-1)?.[1] ?? [];
    const renameItem = items.find((item) => item.testId === "db-context-rename-tab");
    expect(renameItem?.label).toMatch(/rename/i);
    expect(items[0]).toBe(renameItem);

    act(() => renameItem?.onClick?.());
    expect(await screen.findByTestId("db-query-tab-input")).toBeInTheDocument();
  });

  it("records the tab name snapshot on new history entries", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "named-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "named-panel",
        tabOrder: 0,
        content: "select 1",
        filePath: null,
        fileName: null,
        savedQueryId: null,
        displayName: "监控巡检",
        dirty: false,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(screen.getByTestId("db-query-tab")).toHaveTextContent("监控巡检"));

    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(ipcMock.dbAppendHistory).toHaveBeenCalledWith(expect.objectContaining({
        panelId: "named-panel",
        tabName: "监控巡检",
      }));
    });
  });

  it("updates open history entries and shows the name chip after rename", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "named-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "named-panel",
        tabOrder: 0,
        content: "select 1",
        filePath: null,
        fileName: null,
        savedQueryId: null,
        displayName: "订单巡检",
        dirty: false,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });
    ipcMock.dbListHistory.mockResolvedValueOnce([
      {
        id: "hist-1",
        savedSessionId: "saved-pg",
        engine: "PostgreSQL",
        host: "hgpost.example.test",
        port: 80,
        catalog: null,
        databaseName: "cdp",
        schemaName: "public",
        sqlContent: "select 1",
        startedAt: 100,
        durationMs: 12,
        rowsAffected: 0,
        rowCount: 1,
        hasResultSet: true,
        error: null,
        createdAt: 100,
        panelId: "named-panel",
        tabName: null,
      },
      {
        id: "hist-2",
        savedSessionId: "saved-pg",
        engine: "PostgreSQL",
        host: "hgpost.example.test",
        port: 80,
        catalog: null,
        databaseName: "cdp",
        schemaName: "public",
        sqlContent: "select 2",
        startedAt: 90,
        durationMs: 8,
        rowsAffected: 0,
        rowCount: 1,
        hasResultSet: true,
        error: null,
        createdAt: 90,
        panelId: null,
        tabName: null,
      },
    ]);

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(screen.getByTestId("db-query-tab")).toHaveTextContent("订单巡检"));

    fireEvent.click(screen.getByTitle("Query history"));
    await waitFor(() => {
      expect(screen.getAllByTestId("db-query-history-entry")).toHaveLength(2);
    });
    expect(screen.queryByTestId("db-query-history-entry-name")).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByTestId("db-query-tab"));
    const input = await screen.findByTestId("db-query-tab-input");
    fireEvent.change(input, { target: { value: "订单排查" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("db-query-history-entry-name")).toHaveTextContent("订单排查");
    });
    expect(screen.getAllByTestId("db-query-history-entry-name")).toHaveLength(1);
  });
}

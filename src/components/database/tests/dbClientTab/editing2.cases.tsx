import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import type { DbSavedQuery } from "../../../../lib/ipc";
import { getQueryTab } from "../../../../lib/queryRegistry";
import type { DbConnectInfo } from "../../../../types";
import DbClientTab from "../../DbClientTab";
import { contextMenuShow, dbChildProps, deferred, ipcMock, panweiInfo, postgresInfo, waitForConnectedEditor } from "./harness";

export function registerDbClientTabEditing2Cases() {

  it("keeps queries on the latest runtime connection when a stale StrictMode connect resolves late", async () => {
    const firstConnect = deferred<{ ok: boolean; }>();
    const secondConnect = deferred<{ ok: boolean; }>();
    ipcMock.dbConnect
      .mockImplementationOnce(() => firstConnect.promise)
      .mockImplementationOnce(() => secondConnect.promise);

    render(
      <StrictMode>
        <DbClientTab tabId="tab-1" info={postgresInfo} visible />
      </StrictMode>,
    );

    await waitFor(() => expect(ipcMock.dbConnect).toHaveBeenCalledTimes(2));
    const connectCalls = ipcMock.dbConnect.mock.calls as Array<[DbConnectInfo]>;
    const firstRuntimeId = connectCalls[0][0].sessionId;
    const secondRuntimeId = connectCalls[1][0].sessionId;
    expect(firstRuntimeId).toMatch(/^saved-pg::/);
    expect(secondRuntimeId).toMatch(/^saved-pg::/);
    expect(secondRuntimeId).not.toBe(firstRuntimeId);

    await act(async () => {
      secondConnect.resolve({ ok: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("schema-tree")).toHaveAttribute("data-session-id", secondRuntimeId);
    });

    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledWith(
        secondRuntimeId,
        "select 1",
        1000,
        expect.any(Function),
      );
    });

    await act(async () => {
      firstConnect.resolve({ ok: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      const disconnectCalls = ipcMock.dbDisconnect.mock.calls as unknown as Array<[string]>;
      const oldDisconnects = disconnectCalls.filter(([id]) => id === firstRuntimeId);
      expect(oldDisconnects.length).toBeGreaterThanOrEqual(2);
    });
    const disconnectCalls = ipcMock.dbDisconnect.mock.calls as unknown as Array<[string]>;
    expect(disconnectCalls.some(([id]) => id === secondRuntimeId)).toBe(false);
  });

  it("shares one metadata cache between schema tree and SQL editor", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => {
      expect(screen.getByTestId("schema-tree")).toBeInTheDocument();
      expect(dbChildProps.schemaTree?.metadataCache).toBeTruthy();
      expect(dbChildProps.sqlEditor?.metadataCache).toBe(dbChildProps.schemaTree?.metadataCache);
    });
  });

  it("keeps query drafts and the library available when the connection fails", async () => {
    ipcMock.dbConnect.mockRejectedValueOnce(new Error("database offline"));

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    expect(await screen.findByTestId("db-connection-error-banner")).toHaveTextContent("database offline");
    fireEvent.click(screen.getByRole("button", { name: "Queries" }));
    expect(screen.getByTestId("query-library-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-sql-editor")).toBeInTheDocument();
  });

  it("restores SQL editor content from the SQLite query workspace", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "restored-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "restored-panel",
        tabOrder: 0,
        content: "select restored_from_sqlite",
        filePath: null,
        fileName: null,
        dirty: true,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => {
      expect(dbChildProps.sqlEditor?.initialDoc).toBe("select restored_from_sqlite");
    });
  });

  it("flushes the latest editor buffer through the query registry", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(getQueryTab("tab-1")?.flushWorkspace).toBeTypeOf("function"));

    act(() => {
      getQueryTab("tab-1")?.insertQuery("select persisted_buffer", { position: "replaceAll" });
    });
    await act(async () => {
      await getQueryTab("tab-1")?.flushWorkspace?.();
    });

    expect(ipcMock.dbSaveQueryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "saved-pg",
      activePanelId: expect.any(String),
      tabs: [expect.objectContaining({ content: "select persisted_buffer" })],
    }));
  });

  it("restores a saved-query link and flushes edits to both repositories", async () => {
    const savedQuery: DbSavedQuery = {
      id: "saved-query-1",
      scopeType: "connection",
      scopeId: "saved-pg",
      engine: "PostgreSQL",
      catalogName: null,
      databaseName: "cdp",
      schemaName: "public",
      namespaceKey: "namespace",
      name: "Linked query",
      content: "select original",
      remarks: null,
      tags: [],
      revision: 1,
      archivedAt: null,
      createdAt: 100,
      updatedAt: 100,
    };
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbGetSavedQuery.mockResolvedValueOnce(savedQuery);
    ipcMock.dbSaveSavedQuery.mockImplementation(async (query: DbSavedQuery) => ({
      ...query,
      revision: query.revision + 1,
    }));
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "linked-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "linked-panel",
        tabOrder: 0,
        content: "select original",
        filePath: null,
        fileName: null,
        savedQueryId: "saved-query-1",
        dirty: false,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(dbChildProps.sqlEditor?.initialDoc).toBe("select original"));

    act(() => {
      dbChildProps.sqlEditor?.setValue?.("select changed");
      dbChildProps.sqlEditor?.onDocChange?.("select changed");
    });
    await act(async () => {
      await getQueryTab("tab-1")?.flushWorkspace?.();
    });

    expect(ipcMock.dbSaveSavedQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: "saved-query-1",
      revision: 1,
      content: "select changed",
    }));
    expect(ipcMock.dbSaveQueryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      tabs: [expect.objectContaining({
        savedQueryId: "saved-query-1",
        content: "select changed",
        dirty: false,
      })],
    }));
  });

  it("does not rewrite workspace metadata for document-only changes", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(dbChildProps.sqlEditor?.onDocChange).toBeTypeOf("function"));
    setItem.mockClear();

    act(() => dbChildProps.sqlEditor?.onDocChange?.("select 2"));

    expect(
      setItem.mock.calls.some(([key]) => String(key).startsWith("taomni.db.queryWorkspace.v1.")),
    ).toBe(false);
  });

  it("uses PanWeiDB schema metadata instead of treating the connection database as the schema", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbListSchemas.mockResolvedValueOnce([{ name: "panwei_omm" }, { name: "public" }]);

    render(<DbClientTab tabId="tab-panwei" info={panweiInfo} visible />);

    const schemaSelect = await screen.findByLabelText("Schema");
    await waitFor(() => expect(schemaSelect).toHaveValue("panwei_omm"));
    expect(ipcMock.dbListSchemas).toHaveBeenCalledWith(
      expect.stringMatching(/^saved-panwei::/),
      null,
    );
    expect(ipcMock.dbListTables).not.toHaveBeenCalled();
  });

  it("appends echoed agent SQL with comments and semicolons into one query panel", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    expect(getQueryTab("tab-1")).toBeTruthy();
    const entry = getQueryTab("tab-1");
    expect(entry).toBeTruthy();

    act(() => {
      entry?.appendEchoSql("select * from foo", "-- Claude Code ok");
      entry?.appendEchoSql("select * from bar;\n", "-- Claude Code captured");
    });

    await waitFor(() => {
      const editorButton = screen.getByTestId("mock-sql-editor");
      expect(editorButton).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("Run (F5)"));

    // PostgreSQL scripts are split client-side so each statement is prepared alone (#403).
    await waitFor(() => {
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2);
      expect(ipcMock.dbExecuteStream).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/^saved-pg::/),
        "-- Claude Code ok\nselect * from foo",
        1000,
        expect.any(Function),
      );
      expect(ipcMock.dbExecuteStream).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^saved-pg::/),
        "-- Claude Code captured\nselect * from bar",
        1000,
        expect.any(Function),
      );
    });
    expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2);
  });

  it("shows the execution start time on result sheets", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 6, 2, 11, 12, 13).getTime());

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(screen.getByText("11:12:13")).toBeInTheDocument();
      expect(screen.getAllByTitle(/Started: 2026-07-02 11:12:13/).length).toBeGreaterThan(0);
    });
  });

  it("uses the shared tab limit for query tabs and result tabs", async () => {
    localStorage.setItem("taomni.db.PostgreSQL.tabLimit", "2");
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    expect(screen.getByTestId("db-tab-limit")).toHaveValue(2);

    fireEvent.click(screen.getByTitle("New query panel"));
    await waitFor(() => expect(screen.getByTitle("Query 2")).toBeInTheDocument());
    expect(screen.queryByTitle("New query panel")).not.toBeInTheDocument();

    for (let run = 0; run < 3; run += 1) {
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(Math.min(run + 1, 2));
      });
    }
  });

  it("supports batch close actions from the result sheet context menu", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();

    // Open three result sheets (one Run per statement for a stable tab order).
    for (let count = 1; count <= 3; count += 1) {
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(count);
      });
    }

    type MenuItem = {
      label: string;
      testId?: string;
      disabled?: boolean;
      onClick?: () => void;
    };
    const lastSheetMenu = (): MenuItem[] => {
      const menuCalls = contextMenuShow.mock.calls as Array<[unknown, MenuItem[]]>;
      const sheetMenuCall = [...menuCalls].reverse().find(([, items]) =>
        items.some((item) => item.testId === "result-sheet-close-others"),
      );
      expect(sheetMenuCall).toBeTruthy();
      return sheetMenuCall![1];
    };

    const sheets = screen.getAllByTestId("result-sheet-tab");
    fireEvent.contextMenu(sheets[1]);
    const items = lastSheetMenu();
    expect(items.find((item) => item.testId === "result-sheet-close-left")?.disabled).toBe(false);
    expect(items.find((item) => item.testId === "result-sheet-close-right")?.disabled).toBe(false);
    expect(items.find((item) => item.testId === "result-sheet-close-others")?.disabled).toBe(false);

    act(() => {
      items.find((item) => item.testId === "result-sheet-close-others")?.onClick?.();
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(1);
      expect(screen.getByText("Result 2")).toBeInTheDocument();
    });

    // Rebuild more sheets and verify close left / right / all.
    for (let count = 2; count <= 4; count += 1) {
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(count);
      });
    }

    fireEvent.contextMenu(screen.getAllByTestId("result-sheet-tab")[1]);
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-left")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(3);
    });

    fireEvent.contextMenu(screen.getAllByTestId("result-sheet-tab")[0]);
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-right")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(1);
    });

    fireEvent.contextMenu(screen.getByTestId("result-sheet-tab"));
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-all")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId("result-sheet-tab")).toHaveLength(0);
    });
  });

  it("creates one generated SQL query panel only after manual sync", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => expect(screen.getByTestId("query-result-grid")).toBeInTheDocument());
    expect(screen.queryAllByTitle("Generated SQL")).toHaveLength(0);
    expect(screen.getByTestId("query-result-grid")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-generated-sql"));

    await waitFor(() => expect(screen.getAllByTitle("Generated SQL")).toHaveLength(1));
  });

  it("queries generated SQL by replacing the source statement and refreshing the current sheet", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;";
    dbChildProps.generatedRequest = {
      engine: "PostgreSQL",
      sourceSql: "select 1",
      resultColumns: ["one"],
      visibleColumnIndexes: [0],
      globalFilterText: "",
      filters: [],
      sorts: [{ columnIndex: 0, dir: "desc" }],
    };
    ipcMock.dbRewriteResultSql.mockResolvedValueOnce({
      sql: dbChildProps.generatedSql,
      mode: "inline",
      reason: null,
      warnings: [],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("query-result-grid")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("query-generated-sql"));

    await waitFor(() => {
      expect(ipcMock.dbRewriteResultSql).toHaveBeenCalledWith(dbChildProps.generatedRequest);
    });
    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toContain("ORDER BY \"one\" DESC");
      expect(calls.at(-1)?.[1]).not.toContain(";;");
    });

    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toContain("ORDER BY \"one\" DESC");
      expect(calls.at(-1)?.[1]).not.toContain(";;");
    });
  });

  it("runs the current editor statement at the cursor", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Current statement actions"));
    await waitFor(() => expect(screen.getByTestId("db-current-statement-panel")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("db-current-statement-run"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toBe("select 2");
    });
  });
}

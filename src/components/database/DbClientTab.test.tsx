import { StrictMode, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DbClientTab from "./DbClientTab";
import type { DbConnectInfo } from "../../types";
import type { DbQueryWorkspace, DbSavedQuery, DbSqlHistoryEntry } from "../../lib/ipc";
import { getQueryTab } from "../../lib/queryRegistry";
import { useAppStore } from "../../stores/appStore";

// Full DbClientTab mounts are heavy; the 1s default flakes when workers are busy.
configure({ asyncUtilTimeout: 5000 });

const ipcMock = vi.hoisted(() => ({
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(async () => undefined),
  dbExecute: vi.fn(async () => ({ columns: [], rows: [], rowsAffected: 0, durationMs: 1, warnings: [] })),
  dbRewriteResultSql: vi.fn(async (request: { sourceSql: string }) => ({
    sql: request.sourceSql,
    mode: "inline",
    reason: null,
    warnings: [],
  })),
  dbExecuteStream: vi.fn(async (
    _sessionId: string,
    _sql: string,
    _maxRows: number | null,
    onEvent: (event: { kind: "columns" | "rows" | "done"; columns?: unknown[]; rows?: unknown[][]; rowsAffected?: number; durationMs?: number; warnings?: string[] }) => void,
  ) => {
    onEvent({ kind: "columns", columns: [{ name: "one", type: "int4" }] });
    onEvent({ kind: "rows", rows: [["1"]] });
    onEvent({ kind: "done", rowsAffected: 0, durationMs: 1, warnings: [] });
  }),
  dbCancel: vi.fn(async () => undefined),
  dbTxStatus: vi.fn(async (_sessionId: string) => ({ supported: true, manual: false, pending: 0, generation: 1 })),
  dbTxSetManual: vi.fn(async (_sessionId: string, manual: boolean) => ({ supported: true, manual, pending: 0, generation: 1 })),
  dbTxCommit: vi.fn(async (_sessionId: string) => ({ supported: true, manual: true, pending: 0, generation: 1 })),
  dbTxRollback: vi.fn(async (_sessionId: string) => ({ supported: true, manual: true, pending: 0, generation: 1 })),
  dbAppendHistory: vi.fn(async () => undefined),
  dbListHistory: vi.fn(async (): Promise<DbSqlHistoryEntry[]> => []),
  dbDeleteHistory: vi.fn(async () => undefined),
  dbClearHistory: vi.fn(async () => undefined),
  dbUpdateHistoryTabName: vi.fn(async () => 0),
  dbLoadQueryWorkspace: vi.fn(async (): Promise<DbQueryWorkspace | null> => null),
  dbSaveQueryWorkspace: vi.fn(async () => undefined),
  dbGetSavedQuery: vi.fn(async (): Promise<DbSavedQuery | null> => null),
  dbSaveSavedQuery: vi.fn(),
  dbCloseQueryWorkspaceTabs: vi.fn(async () => undefined),
  dbListCatalogs: vi.fn(async () => []),
  dbListSchemas: vi.fn(async () => [{ name: "cdp" }]),
  dbListTables: vi.fn(async () => []),
  dbSearchTables: vi.fn(async () => []),
  dbListForeignKeys: vi.fn(async () => []),
  dbDescribeTable: vi.fn(async () => []),
}));

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  );
  const Panel = forwardRef<unknown, { children: React.ReactNode; panelRef?: React.Ref<unknown> }>(({ children, panelRef }, ref) => {
    const handle = {
      resize: vi.fn(),
    };
    useImperativeHandle(ref, () => handle);
    useImperativeHandle(panelRef, () => handle);
    return <div data-testid="panel">{children}</div>;
  });
  const Separator = () => <div data-testid="panel-resize-handle" />;
  return {
    Group,
    Panel,
    Separator,
    PanelGroup: Group,
    PanelResizeHandle: Separator,
  };
});

vi.mock("../../lib/ipc", () => ({
  checkFileExists: vi.fn(async () => false),
  dbConnect: ipcMock.dbConnect,
  dbDisconnect: ipcMock.dbDisconnect,
  dbExecute: ipcMock.dbExecute,
  dbRewriteResultSql: ipcMock.dbRewriteResultSql,
  dbExecuteStream: ipcMock.dbExecuteStream,
  dbCancel: ipcMock.dbCancel,
  dbTxStatus: ipcMock.dbTxStatus,
  dbTxSetManual: ipcMock.dbTxSetManual,
  dbTxCommit: ipcMock.dbTxCommit,
  dbTxRollback: ipcMock.dbTxRollback,
  dbAppendHistory: ipcMock.dbAppendHistory,
  dbListHistory: ipcMock.dbListHistory,
  dbDeleteHistory: ipcMock.dbDeleteHistory,
  dbClearHistory: ipcMock.dbClearHistory,
  dbUpdateHistoryTabName: ipcMock.dbUpdateHistoryTabName,
  dbLoadQueryWorkspace: ipcMock.dbLoadQueryWorkspace,
  dbSaveQueryWorkspace: ipcMock.dbSaveQueryWorkspace,
  dbGetSavedQuery: ipcMock.dbGetSavedQuery,
  dbSaveSavedQuery: ipcMock.dbSaveSavedQuery,
  dbCloseQueryWorkspaceTabs: ipcMock.dbCloseQueryWorkspaceTabs,
  dbListCatalogs: ipcMock.dbListCatalogs,
  dbListSchemas: ipcMock.dbListSchemas,
  dbListTables: ipcMock.dbListTables,
  dbSearchTables: ipcMock.dbSearchTables,
  dbListForeignKeys: ipcMock.dbListForeignKeys,
  dbDescribeTable: ipcMock.dbDescribeTable,
  dbListBookmarks: vi.fn(async () => []),
  dbSaveBookmark: vi.fn(async () => undefined),
  dbDeleteBookmark: vi.fn(async () => undefined),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  selectSaveFilePath: vi.fn(async () => null),
  temporaryFilePath: vi.fn(async (name: string) => `/tmp/${name}`),
  writeStreamAbort: vi.fn(async () => undefined),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamOpen: vi.fn(async () => "stream-1"),
}));

const dbChildProps = vi.hoisted(() => ({
  schemaTree: null as null | { metadataCache?: unknown },
  sqlEditor: null as null | {
    metadataCache?: unknown;
    onDocChange?: (doc: string) => void;
    initialDoc?: string;
    setValue?: (doc: string) => void;
  },
  editorInitialDocFallback: "select 1",
  generatedSql: "select 1\nORDER BY \"one\" DESC;",
  generatedRequest: null as null | {
    engine: string;
    sourceSql: string;
    resultColumns: string[];
    visibleColumnIndexes: number[];
    globalFilterText: string;
    filters: unknown[];
    sorts: Array<{ columnIndex: number; dir: "asc" | "desc" }>;
  },
}));

vi.mock("./SchemaTree", () => ({
  SchemaTree: (props: { sessionId: string; metadataCache?: unknown }) => {
    dbChildProps.schemaTree = props;
    return <div data-testid="schema-tree" data-session-id={props.sessionId} />;
  },
}));

vi.mock("./SqlEditorPanel", () => ({
  SqlEditorPanel: ({
    handleRef,
    onRun,
    onDocChange,
    metadataCache,
    initialDoc,
  }: {
    handleRef: (handle: unknown | null) => void;
    onRun: (sql: string) => void;
    onDocChange?: (doc: string) => void;
    metadataCache?: unknown;
    initialDoc?: string;
  }) => {
    useEffect(() => {
      let doc = initialDoc || dbChildProps.editorInitialDocFallback;
      const handle = {
        getValue: () => doc,
        getSelectionOrAll: () => "select 1",
        getCursorPosition: () => doc.length,
        getSelectionRange: () => null,
        insertText: vi.fn(),
        setValue: vi.fn((text: string) => {
          doc = text;
        }),
        selectRange: vi.fn(),
        replaceRange: vi.fn((from: number, to: number, text: string) => {
          doc = `${doc.slice(0, from)}${text}${doc.slice(to)}`;
        }),
        focus: vi.fn(),
      };
      dbChildProps.sqlEditor = { metadataCache, onDocChange, initialDoc, setValue: handle.setValue };
      handleRef(handle);
      return () => handleRef(null);
    }, [handleRef, initialDoc]);
    return (
      <button type="button" data-testid="mock-sql-editor" onClick={() => onRun("select 1")}>
        editor
      </button>
    );
  },
}));

vi.mock("./QueryResultGrid", () => ({
  QueryResultGrid: ({
    onGeneratedSqlSync,
    onGeneratedSqlQuery,
  }: {
    onGeneratedSqlSync?: (sql: string, mode: "sync" | "replaceSource") => void;
    onGeneratedSqlQuery?: (sql: string, request?: typeof dbChildProps.generatedRequest) => void;
  }) => {
    return (
      <div data-testid="query-result-grid">
        <button type="button" data-testid="sync-generated-sql" onClick={() => onGeneratedSqlSync?.(dbChildProps.generatedSql, "sync")}>
          sync generated
        </button>
        <button type="button" data-testid="query-generated-sql" onClick={() => onGeneratedSqlQuery?.(dbChildProps.generatedSql, dbChildProps.generatedRequest ?? undefined)}>
          query generated
        </button>
      </div>
    );
  },
}));

vi.mock("../tabbar/TabActionSlot", () => ({
  TabActions: ({ active, children }: { active: boolean; children: React.ReactNode }) =>
    active ? <div data-testid="tab-action-slot">{children}</div> : null,
}));

const dialogMock = vi.hoisted(() => ({
  choice: vi.fn(async (_options: { title?: string; message: string; primaryLabel: string; secondaryLabel: string; cancelLabel?: string }): Promise<"primary" | "secondary" | null> => null),
  confirm: vi.fn(async (_options: { title?: string; message: string; confirmLabel?: string; danger?: boolean }) => true),
  alert: vi.fn(async (_options: { title?: string; message: string }) => undefined),
}));

vi.mock("../../lib/appDialogs", () => ({
  choiceAppDialog: dialogMock.choice,
  confirmAppDialog: dialogMock.confirm,
  alertAppDialog: dialogMock.alert,
}));

const contextMenuShow = vi.hoisted(() => vi.fn());

vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({ show: contextMenuShow, render: null, showAt: vi.fn(), refreshItems: vi.fn(), close: vi.fn(), isOpen: false }),
}));


/**
 * The schema tree appears on the commit that connects; the mocked editor
 * registers its handle in a passive effect that may flush later. Flush
 * effects so toolbar clicks read the editor document.
 */
async function waitForConnectedEditor() {
  await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
  await act(async () => undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const postgresInfo: DbConnectInfo = {
  sessionId: "saved-pg",
  workspaceSessionId: "saved-pg",
  engine: "PostgreSQL",
  host: "hgpost.example.test",
  port: 80,
  username: "ak",
  password: "sk",
  database: "cdp",
  ssl: false,
};

const panweiInfo: DbConnectInfo = {
  sessionId: "saved-panwei",
  workspaceSessionId: "saved-panwei",
  engine: "PanWeiDB",
  host: "192.168.152.250",
  port: 17700,
  username: "panwei_omm",
  password: "secret",
  database: "panweidb",
  ssl: false,
};

describe("DbClientTab connection lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.schemaTree = null;
    dbChildProps.sqlEditor = null;
    dbChildProps.editorInitialDocFallback = "select 1";
    dbChildProps.generatedSql = "select 1\nORDER BY \"one\" DESC;";
    dbChildProps.generatedRequest = null;
    contextMenuShow.mockClear();
  });

  it("keeps queries on the latest runtime connection when a stale StrictMode connect resolves late", async () => {
    const firstConnect = deferred<{ ok: boolean }>();
    const secondConnect = deferred<{ ok: boolean }>();
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

    type MenuItemStub = { label: string; testId?: string; onClick?: () => void };
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
});

type StreamEvent = { kind: "columns" | "rows" | "done"; columns?: unknown[]; rows?: unknown[][]; rowsAffected?: number; durationMs?: number; warnings?: string[] };

function streamOk(onEvent: (event: StreamEvent) => void) {
  onEvent({ kind: "columns", columns: [{ name: "one", type: "int4" }] });
  onEvent({ kind: "rows", rows: [["1"]] });
  onEvent({ kind: "done", rowsAffected: 0, durationMs: 3, warnings: [] });
}

describe("DbClientTab execution log", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.editorInitialDocFallback = "select 1";
  });

  it("logs every statement, switches to the Log after a failure and keeps result sheets", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect missing;\nselect 3";
    ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
      if (sql.includes("missing")) throw new Error("1146 (42S02): Table 'missing' doesn't exist");
      streamOk(onEvent);
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => expect(screen.getByTestId("db-execution-log")).toBeInTheDocument());
    expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "true");
    const entries = screen.getAllByTestId("db-execution-log-entry");
    expect(entries.map((entry) => entry.getAttribute("data-status"))).toEqual(["success", "failed", "not-run"]);
    expect(screen.getAllByTestId("db-execution-log-message")[1]).toHaveTextContent("Table 'missing' doesn't exist");
    expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 1 · Failed: 1 · Not run: 1");
    expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2);
    expect(ipcMock.dbAppendHistory).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getAllByTestId("result-sheet-tab")[0]);
    expect(screen.queryByTestId("db-execution-log")).not.toBeInTheDocument();
    expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "false");
  });

  it("stays on the last result sheet when every statement succeeds", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
    ipcMock.dbExecuteStream.mockImplementation(async (_session: string, _sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
      streamOk(onEvent);
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "false"));
    fireEvent.click(screen.getByTestId("result-log-tab"));
    expect(screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"))).toEqual([
      "success",
      "success",
    ]);
    expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 2 · Failed: 0");
  });

  it("keeps the Log open when it is selected while a run is in progress", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
    const first = deferred<void>();
    ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
      if (sql === "select 1") await first.promise;
      streamOk(onEvent);
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("result-log-tab")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("result-log-tab"));
    await act(async () => first.resolve());

    await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 2"));
    expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "true");
  });

  it("marks a cancelled statement and the following ones as not run", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select sleep(30);\nselect 2";
    const pending = deferred<void>();
    ipcMock.dbExecuteStream.mockImplementation(async () => {
      await pending.promise;
      throw new Error("Query execution was interrupted");
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTitle("Cancel query")).not.toBeDisabled());
    fireEvent.click(screen.getByTitle("Cancel query"));
    await act(async () => pending.resolve());

    await waitFor(() => expect(screen.getByTestId("db-execution-log")).toBeInTheDocument());
    expect(screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"))).toEqual([
      "cancelled",
      "not-run",
    ]);
    expect(ipcMock.dbCancel).toHaveBeenCalled();
    expect(dialogMock.choice).not.toHaveBeenCalled();
  });
});

describe("DbClientTab error choice", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.editorInitialDocFallback = "select 1";
  });

  function failWhen(match: (sql: string) => boolean) {
    ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
      if (match(sql)) throw new Error(`boom: ${sql}`);
      streamOk(onEvent);
    });
  }

  async function runDoc(doc: string) {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = doc;
    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTitle("Run (F5)"));
  }

  const statuses = () => screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"));

  it("asks on a middle failure: Skip continues, Stop halts the rest", async () => {
    failWhen((sql) => sql.startsWith("bad"));
    dialogMock.choice.mockResolvedValueOnce("secondary").mockResolvedValueOnce(null);
    await runDoc("bad 1;\nbad 2;\nselect 3");

    await waitFor(() => expect(dialogMock.choice).toHaveBeenCalledTimes(2));
    expect(dialogMock.choice.mock.calls[0][0]).toMatchObject({ primaryLabel: "Skip all", secondaryLabel: "Skip", cancelLabel: "Stop" });
    const message = dialogMock.choice.mock.calls[0][0].message;
    expect(message).toContain("Statement 1 of 3 failed:\n");
    expect(message).toContain("boom: bad 1");
    await waitFor(() => expect(statuses()).toEqual(["failed", "failed", "not-run"]));
    expect(screen.getAllByTestId("db-execution-log-message")[0]).toHaveTextContent("(skipped, run continued)");
  });

  it("Skip all continues without asking again", async () => {
    failWhen((sql) => sql.startsWith("bad"));
    dialogMock.choice.mockResolvedValueOnce("primary");
    await runDoc("bad 1;\nbad 2;\nselect 3");

    await waitFor(() => expect(statuses()).toEqual(["failed", "failed", "success"]));
    expect(dialogMock.choice).toHaveBeenCalledTimes(1);
    expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(3);
  });

  it("confirms dangerous statements and runs nothing when canceled", async () => {
    failWhen(() => false);
    dialogMock.confirm.mockResolvedValueOnce(false);
    await runDoc("select 1;\ndrop table t");

    await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalledTimes(1));
    expect(dialogMock.confirm.mock.calls[0][0]).toMatchObject({ title: "Confirm dangerous statements", danger: true });
    expect(dialogMock.confirm.mock.calls[0][0].message).toContain("[DROP] drop table t");
    await act(async () => undefined);
    expect(ipcMock.dbExecuteStream).not.toHaveBeenCalled();
    expect(screen.queryByTestId("result-log-tab")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("result-sheet-tab")).toHaveLength(0);
  });

  it("runs the whole script after confirming dangerous statements and skips the prompt for safe runs", async () => {
    failWhen(() => false);
    dialogMock.confirm.mockResolvedValueOnce(true);
    await runDoc("select 1;\ndelete from t");

    await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
    await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("result-log-tab"));
    await waitFor(() => expect(statuses()).toEqual(["success", "success"]));

    cleanup();
    vi.clearAllMocks();
    await runDoc("select 1;\ndelete from t where id = 1");
    await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2));
    expect(dialogMock.confirm).not.toHaveBeenCalled();
  });

  it("explains the statement at the cursor into an Explain sheet", async () => {
    failWhen(() => false);
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTestId("db-explain-current"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.map((call) => call[1])).toEqual(["EXPLAIN select 2"]);
    });
    await waitFor(() => expect(screen.getByTestId("result-sheet-tab")).toHaveTextContent("Explain"));
  });

  it("explains why a statement cannot be explained and runs nothing", async () => {
    failWhen(() => false);
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "create table t (id int)";
    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitForConnectedEditor();
    fireEvent.click(screen.getByTestId("db-explain-current"));

    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledTimes(1));
    expect(dialogMock.alert.mock.calls[0][0].message).toContain("Explain supports");
    expect(ipcMock.dbExecuteStream).not.toHaveBeenCalled();
  });

  it("does not ask when the last statement fails", async () => {
    failWhen((sql) => sql.startsWith("bad"));
    await runDoc("select 1;\nbad 2");

    await waitFor(() => expect(statuses()).toEqual(["success", "failed"]));
    expect(dialogMock.choice).not.toHaveBeenCalled();
  });
});

describe("DbClientTab manual commit", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.editorInitialDocFallback = "select 1";
  });

  /** Stateful fake of the backend TxState: inserts count while manual. */
  function fakeTx() {
    // `dropNext` simulates the pool opening a new connection before the next statement.
    const state = { supported: true, manual: false, pending: 0, generation: 1, dropNext: false };
    const snapshot = () => ({ supported: state.supported, manual: state.manual, pending: state.pending, generation: state.generation });
    ipcMock.dbTxStatus.mockImplementation(async () => snapshot());
    ipcMock.dbTxSetManual.mockImplementation(async (_sessionId: string, manual: boolean) => {
      state.manual = manual;
      state.pending = 0;
      return snapshot();
    });
    const end = async () => {
      state.pending = 0;
      return snapshot();
    };
    ipcMock.dbTxCommit.mockImplementation(end);
    ipcMock.dbTxRollback.mockImplementation(end);
    ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
      if (state.dropNext) {
        state.dropNext = false;
        state.generation += 1;
        state.pending = 0;
      }
      if (state.manual && /^insert/i.test(sql)) state.pending += 1;
      onEvent({ kind: "done", rowsAffected: 1, durationMs: 1, warnings: [] });
    });
    return state;
  }

  async function renderConnected(doc: string) {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = doc;
    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).not.toBeDisabled());
  }

  it("switches to manual, counts pending writes and commits or rolls back", async () => {
    fakeTx();
    await renderConnected("insert into t values (1)");
    expect(screen.getByTestId("db-tx-mode")).toHaveTextContent("Auto");
    expect(screen.queryByTestId("db-tx-commit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
    expect(ipcMock.dbTxSetManual).toHaveBeenCalledWith(expect.any(String), true);
    expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0");

    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
    fireEvent.click(screen.getByTestId("db-tx-commit"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
    expect(ipcMock.dbTxCommit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
    fireEvent.click(screen.getByTestId("db-tx-rollback"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
    expect(ipcMock.dbTxRollback).toHaveBeenCalledTimes(1);
  });

  it("confirms before switching back to auto-commit with pending statements", async () => {
    fakeTx();
    await renderConnected("insert into t values (1)");
    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

    dialogMock.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalledTimes(1));
    expect(dialogMock.confirm.mock.calls[0][0]).toMatchObject({
      title: "Switch to auto-commit",
      message: "1 pending statement(s) will be committed.",
    });
    await act(async () => undefined);
    expect(ipcMock.dbTxSetManual).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual");

    dialogMock.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "auto"));
    expect(ipcMock.dbTxSetManual).toHaveBeenLastCalledWith(expect.any(String), false);
    expect(screen.queryByTestId("db-tx-commit")).not.toBeInTheDocument();
  });

  it("warns once when a reconnect drops uncommitted statements", async () => {
    const state = fakeTx();
    await renderConnected("insert into t values (1)");
    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

    state.dropNext = true;
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledTimes(1));
    expect(dialogMock.alert.mock.calls[0][0]).toEqual({
      title: "Connection re-established",
      message: "The database connection was re-established. 1 uncommitted statement(s) were lost.",
    });
    // The insert that just ran on the new connection is the only pending one.
    expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1");

    fireEvent.click(screen.getByTestId("db-tx-rollback"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
    state.dropNext = true;
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
    expect(dialogMock.alert).toHaveBeenCalledTimes(1);
  });

  it("rolls back pending statements before disconnecting when the tab closes", async () => {
    fakeTx();
    await renderConnected("insert into t values (1)");
    fireEvent.click(screen.getByTestId("db-tx-mode"));
    await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

    // An earlier test's deferred rollback -> disconnect may land late; count from here.
    ipcMock.dbDisconnect.mockClear();
    ipcMock.dbTxRollback.mockClear();
    cleanup();
    await waitFor(() => expect(ipcMock.dbDisconnect).toHaveBeenCalledTimes(1));
    expect(ipcMock.dbTxRollback).toHaveBeenCalledTimes(1);
    expect(ipcMock.dbTxRollback.mock.invocationCallOrder[0]).toBeLessThan(ipcMock.dbDisconnect.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().statusMessage).toBe("Rolled back 1 uncommitted statement(s) when the database tab closed.");
  });

  it("only disconnects on close in auto-commit mode", async () => {
    fakeTx();
    await renderConnected("insert into t values (1)");
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(1));
    // An earlier test's deferred rollback -> disconnect may land late; count from here.
    ipcMock.dbDisconnect.mockClear();
    ipcMock.dbTxRollback.mockClear();
    cleanup();
    await waitFor(() => expect(ipcMock.dbDisconnect).toHaveBeenCalledTimes(1));
    expect(ipcMock.dbTxRollback).not.toHaveBeenCalled();
  });

  it("keeps the toggle disabled until connected and hides it for other engines", async () => {
    fakeTx();
    ipcMock.dbConnect.mockRejectedValueOnce(new Error("offline"));
    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(ipcMock.dbConnect).toHaveBeenCalled());
    expect(screen.getByTestId("db-tx-mode")).toBeDisabled();
    expect(screen.getByTestId("db-tx-mode")).toHaveTextContent("Auto");
    cleanup();

    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    render(<DbClientTab tabId="tab-2" info={{ ...postgresInfo, engine: "ClickHouse" }} visible />);
    await waitForConnectedEditor();
    expect(screen.queryByTestId("db-tx-mode")).not.toBeInTheDocument();
    expect(ipcMock.dbTxStatus).not.toHaveBeenCalled();
  });
});

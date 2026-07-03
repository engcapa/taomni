import { StrictMode, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DbClientTab from "./DbClientTab";
import type { DbConnectInfo } from "../../types";
import { getQueryTab } from "../../lib/queryRegistry";

const ipcMock = vi.hoisted(() => ({
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(async () => undefined),
  dbExecute: vi.fn(async () => ({ columns: [], rows: [], rowsAffected: 0, durationMs: 1, warnings: [] })),
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
  dbListCatalogs: vi.fn(async () => []),
  dbListSchemas: vi.fn(async () => [{ name: "cdp" }]),
  dbListTables: vi.fn(async () => []),
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
  dbExecuteStream: ipcMock.dbExecuteStream,
  dbCancel: ipcMock.dbCancel,
  dbListCatalogs: ipcMock.dbListCatalogs,
  dbListSchemas: ipcMock.dbListSchemas,
  dbListTables: ipcMock.dbListTables,
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
  sqlEditor: null as null | { metadataCache?: unknown },
  editorInitialDocFallback: "select 1",
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
    metadataCache,
    initialDoc,
  }: {
    handleRef: (handle: unknown | null) => void;
    onRun: (sql: string) => void;
    metadataCache?: unknown;
    initialDoc?: string;
  }) => {
    dbChildProps.sqlEditor = { metadataCache };
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
  QueryResultGrid: () => <div data-testid="query-result-grid" />,
}));

vi.mock("../tabbar/TabActionSlot", () => ({
  TabActions: ({ active, children }: { active: boolean; children: React.ReactNode }) =>
    active ? <div data-testid="tab-action-slot">{children}</div> : null,
}));

vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({ show: vi.fn(), render: null }),
}));

vi.mock("../../lib/capture", () => ({
  captureElementPng: vi.fn(async () => new Uint8Array()),
  renderElementToCanvas: vi.fn(async () => null),
  safeFilePart: (value: string) => value,
}));

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

describe("DbClientTab connection lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.schemaTree = null;
    dbChildProps.sqlEditor = null;
    dbChildProps.editorInitialDocFallback = "select 1";
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

  it("appends echoed agent SQL with comments and semicolons into one query panel", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
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

    await waitFor(() => {
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledWith(
        expect.stringMatching(/^saved-pg::/),
        "-- Claude Code ok\nselect * from foo;\n\n-- Claude Code captured\nselect * from bar;",
        1000,
        expect.any(Function),
      );
    });
  });

  it("shows the execution start time on result sheets", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 6, 2, 11, 12, 13).getTime());

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(screen.getByText("11:12:13")).toBeInTheDocument();
      expect(screen.getAllByTitle(/Started: 2026-07-02 11:12:13/).length).toBeGreaterThan(0);
    });
  });
});

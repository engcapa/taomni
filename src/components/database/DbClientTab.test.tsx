import { StrictMode, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DbClientTab from "./DbClientTab";
import type { DbConnectInfo } from "../../types";

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
  dbDescribeTable: vi.fn(async () => []),
}));

vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  ),
  Panel: forwardRef<unknown, { children: React.ReactNode }>(({ children }, ref) => {
    useImperativeHandle(ref, () => ({
      resize: vi.fn(),
    }));
    return <div data-testid="panel">{children}</div>;
  }),
  PanelResizeHandle: () => <div data-testid="panel-resize-handle" />,
}));

vi.mock("../../lib/ipc", () => ({
  checkFileExists: vi.fn(async () => false),
  dbConnect: ipcMock.dbConnect,
  dbDisconnect: ipcMock.dbDisconnect,
  dbExecute: ipcMock.dbExecute,
  dbExecuteStream: ipcMock.dbExecuteStream,
  dbCancel: ipcMock.dbCancel,
  dbDescribeTable: ipcMock.dbDescribeTable,
  readFileBytes: vi.fn(async () => new Uint8Array()),
  selectSaveFilePath: vi.fn(async () => null),
  temporaryFilePath: vi.fn(async (name: string) => `/tmp/${name}`),
  writeStreamAbort: vi.fn(async () => undefined),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamOpen: vi.fn(async () => "stream-1"),
}));

vi.mock("./SchemaTree", () => ({
  SchemaTree: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="schema-tree" data-session-id={sessionId} />
  ),
}));

vi.mock("./SqlEditorPanel", () => ({
  SqlEditorPanel: ({
    handleRef,
    onRun,
  }: {
    handleRef: (handle: unknown | null) => void;
    onRun: (sql: string) => void;
  }) => {
    useEffect(() => {
      const handle = {
        getValue: () => "select 1",
        getSelectionOrAll: () => "select 1",
        insertText: vi.fn(),
        setValue: vi.fn(),
      };
      handleRef(handle);
      return () => handleRef(null);
    }, [handleRef]);
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

vi.mock("../floating-toolbar/FloatingToolbar", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="floating-toolbar">{children}</div>,
}));

vi.mock("../capture/CaptureToolbar", () => ({
  default: () => <div data-testid="capture-toolbar" />,
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
});

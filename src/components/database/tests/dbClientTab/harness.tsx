import { act, screen, waitFor } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { expect, vi } from "vitest";
import type { DbQueryWorkspace, DbSavedQuery, DbSqlHistoryEntry } from "../../../../lib/ipc";
import type { DbConnectInfo } from "../../../../types";

const ipcMock = vi.hoisted(() => ({
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(async () => undefined),
  dbExecute: vi.fn(async () => ({ columns: [], rows: [], rowsAffected: 0, durationMs: 1, warnings: [] })),
  dbRewriteResultSql: vi.fn(async (request: { sourceSql: string; }) => ({
    sql: request.sourceSql,
    mode: "inline",
    reason: null,
    warnings: [],
  })),
  dbExecuteStream: vi.fn(async (
    _sessionId: string,
    _sql: string,
    _maxRows: number | null,
    onEvent: (event: { kind: "columns" | "rows" | "done"; columns?: unknown[]; rows?: unknown[][]; rowsAffected?: number; durationMs?: number; warnings?: string[]; }) => void,
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
  const Group = ({ children, className }: { children: React.ReactNode; className?: string; }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  );
  const Panel = forwardRef<unknown, { children: React.ReactNode; panelRef?: React.Ref<unknown>; }>(({ children, panelRef }, ref) => {
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

vi.mock("../../../../lib/ipc", () => ({
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
  schemaTree: null as null | { metadataCache?: unknown; },
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
    sorts: Array<{ columnIndex: number; dir: "asc" | "desc"; }>;
  },
}));

vi.mock("../../SchemaTree", () => ({
  SchemaTree: (props: { sessionId: string; metadataCache?: unknown; }) => {
    dbChildProps.schemaTree = props;
    return <div data-testid="schema-tree" data-session-id={props.sessionId} />;
  },
}));

vi.mock("../../SqlEditorPanel", () => ({
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

vi.mock("../../QueryResultGrid", () => ({
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

vi.mock("../../../tabbar/TabActionSlot", () => ({
  TabActions: ({ active, children }: { active: boolean; children: React.ReactNode; }) =>
    active ? <div data-testid="tab-action-slot">{children}</div> : null,
}));

const dialogMock = vi.hoisted(() => ({
  choice: vi.fn(async (_options: { title?: string; message: string; primaryLabel: string; secondaryLabel: string; cancelLabel?: string; }): Promise<"primary" | "secondary" | null> => null),
  confirm: vi.fn(async (_options: { title?: string; message: string; confirmLabel?: string; danger?: boolean; }) => true),
  alert: vi.fn(async (_options: { title?: string; message: string; }) => undefined),
}));

vi.mock("../../../../lib/appDialogs", () => ({
  choiceAppDialog: dialogMock.choice,
  confirmAppDialog: dialogMock.confirm,
  alertAppDialog: dialogMock.alert,
}));

const contextMenuShow = vi.hoisted(() => vi.fn());

vi.mock("../../../ContextMenu", () => ({
  useContextMenu: () => ({ show: contextMenuShow, render: null, showAt: vi.fn(), refreshItems: vi.fn(), close: vi.fn(), isOpen: false }),
}));

/**
 * The schema tree appears on the commit that connects; the mocked editor
 * registers its handle in a passive effect that may flush later. Flush
 * effects so toolbar clicks read the editor document.
 */
export async function waitForConnectedEditor() {
  await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
  await act(async () => undefined);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const postgresInfo: DbConnectInfo = {
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

export const panweiInfo: DbConnectInfo = {
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

export type StreamEvent = { kind: "columns" | "rows" | "done"; columns?: unknown[]; rows?: unknown[][]; rowsAffected?: number; durationMs?: number; warnings?: string[]; };

export function streamOk(onEvent: (event: StreamEvent) => void) {
  onEvent({ kind: "columns", columns: [{ name: "one", type: "int4" }] });
  onEvent({ kind: "rows", rows: [["1"]] });
  onEvent({ kind: "done", rowsAffected: 0, durationMs: 3, warnings: [] });
}

export { contextMenuShow, dbChildProps, dialogMock, ipcMock };

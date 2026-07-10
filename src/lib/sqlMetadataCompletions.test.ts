import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { createDbMetadataCache, DB_METADATA_COMPLETION_LIMIT } from "./dbMetadataCache";
import { codeMirrorSqlDialect } from "./sqlEditorDialect";
import { createSqlMetadataCompletionSource } from "./sqlMetadataCompletions";

const ipcMock = vi.hoisted(() => ({
  dbListCatalogs: vi.fn(async () => [{ name: "hive" }, { name: "iceberg" }]),
  dbListSchemas: vi.fn(async () => [{ name: "sales" }, { name: "marketing" }]),
  dbListTables: vi.fn(async (_sessionId: string, schema: string | null) =>
    schema === "public"
      ? [
          { name: "orders", kind: "table", rowCount: null },
          { name: "customers", kind: "table", rowCount: null },
        ]
      : [
          { name: "orders", kind: "table", rowCount: null },
          { name: "orders_v", kind: "view", rowCount: null },
        ],
  ),
  dbSearchTables: vi.fn(async (
    _sessionId: string,
    schema: string | null,
    _catalog: string | null,
    prefix: string,
    limit: number,
  ) => {
    const tables = schema === "public"
      ? [
          { name: "orders", kind: "table", rowCount: null },
          { name: "customers", kind: "table", rowCount: null },
        ]
      : [
          { name: "orders", kind: "table", rowCount: null },
          { name: "orders_v", kind: "view", rowCount: null },
        ];
    return tables
      .filter((table) => table.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, limit);
  }),
  dbDescribeTable: vi.fn(async () => [
    { name: "id", type: "bigint", nullable: false, default: null, primaryKey: true },
    { name: "total", type: "decimal", nullable: true, default: null, primaryKey: false },
  ]),
}));

vi.mock("./ipc", () => ipcMock);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function complete(
  doc: string,
  opts: {
    engine: string;
    activeSchema?: string | null;
    catalog?: string | null;
    cache?: ReturnType<typeof createDbMetadataCache>;
    onError?: (message: string) => void;
    onLoadingChange?: (loading: boolean) => void;
    onResult?: (result: { count: number; limitReached: boolean }) => void;
  },
): Promise<CompletionResult | null> {
  const pos = doc.indexOf("‸");
  const text = doc.replace("‸", "");
  const state = EditorState.create({
    doc: text,
    extensions: [codeMirrorSqlDialect(opts.engine).extension],
  });
  const context = new CompletionContext(state, pos < 0 ? text.length : pos, true);
  const cache =
    opts.cache ??
    createDbMetadataCache({
      sessionId: "s1",
      defaultCatalog: opts.catalog,
    });
  const source = createSqlMetadataCompletionSource({
    cache,
    engine: opts.engine,
    activeSchema: opts.activeSchema,
    catalog: opts.catalog,
    onError: opts.onError,
    onLoadingChange: opts.onLoadingChange,
    onResult: opts.onResult,
  });
  return (await source(context)) as CompletionResult | null;
}

const labels = (result: CompletionResult | null): string[] =>
  (result?.options ?? []).map((option) => option.label);

afterEach(() => {
  vi.clearAllMocks();
});

describe("createSqlMetadataCompletionSource", () => {
  it("suggests active-schema tables in relation positions without loading the full schema", async () => {
    const onLoadingChange = vi.fn();
    const result = await complete("select * from ord‸", {
      engine: "PostgreSQL",
      activeSchema: "public",
      onLoadingChange,
    });

    expect(labels(result)).toEqual(["orders"]);
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith("s1", "public", null, "ord", 500);
    expect(ipcMock.dbListTables).not.toHaveBeenCalled();
    expect(onLoadingChange.mock.calls.flat()).toEqual([true, false]);
  });

  it("does not query relation metadata without an active schema", async () => {
    const result = await complete("select * from ord‸", {
      engine: "PostgreSQL",
      activeSchema: null,
    });

    expect(result).toBeNull();
    expect(ipcMock.dbSearchTables).not.toHaveBeenCalled();
  });

  it.each([
    "select 'from ord‸'",
    "select 1 -- from ord‸",
    "select /* join ord‸ */ 1",
    'select "from ord‸"',
  ])("does not offer metadata inside strings or comments: %s", async (doc) => {
    const result = await complete(doc, {
      engine: "MySQL",
      activeSchema: "public",
    });

    expect(result).toBeNull();
    expect(ipcMock.dbSearchTables).not.toHaveBeenCalled();
  });

  it("supports quoted identifier prefixes and inserts a complete quoted name", async () => {
    ipcMock.dbSearchTables.mockResolvedValueOnce([
      { name: "Order Items", kind: "table", rowCount: null },
    ]);

    const result = await complete('select * from "Order I‸', {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["Order Items"]);
    expect(result?.from).toBe("select * from ".length);
    expect(result?.options[0]?.apply).toBe('"Order Items"');
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith(
      "s1",
      "public",
      null,
      "Order I",
      500,
    );
  });

  it("supports Unicode identifier prefixes", async () => {
    ipcMock.dbSearchTables.mockResolvedValueOnce([
      { name: "订单", kind: "table", rowCount: null },
    ]);

    const result = await complete("select * from 订‸", {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["订单"]);
    expect(result?.options[0]?.apply).toBeUndefined();
  });

  it("ranks an exact table match ahead of longer prefixes", async () => {
    ipcMock.dbSearchTables.mockResolvedValueOnce([
      { name: "orders_archive", kind: "table", rowCount: null },
      { name: "orders", kind: "table", rowCount: null },
      { name: "orders_view", kind: "view", rowCount: null },
    ]);

    const result = await complete("select * from orders‸", {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["orders", "orders_archive", "orders_view"]);
    expect(result?.options[0]?.boost).toBeGreaterThan(result?.options[1]?.boost ?? 0);
  });

  it("reports metadata errors and always clears loading state", async () => {
    ipcMock.dbSearchTables.mockRejectedValueOnce(new Error("offline"));
    const onError = vi.fn();
    const onLoadingChange = vi.fn();

    const result = await complete("select * from ord‸", {
      engine: "PostgreSQL",
      activeSchema: "public",
      onError,
      onLoadingChange,
    });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith("Error: offline");
    expect(onLoadingChange.mock.calls.flat()).toEqual([true, false]);
  });

  it("drops metadata results after a document-change abort", async () => {
    const pending = deferred<Array<{ name: string; kind: "table"; rowCount: null }>>();
    ipcMock.dbSearchTables.mockReturnValueOnce(pending.promise);
    const state = EditorState.create({ doc: "select * from ord" });
    let aborted = false;
    let abortOnDocChange = false;
    let abort = () => undefined;
    const context = {
      state,
      pos: state.doc.length,
      explicit: true,
      get aborted() {
        return aborted;
      },
      addEventListener: (
        _type: "abort",
        listener: () => void,
        options?: { onDocChange: boolean },
      ) => {
        abortOnDocChange = options?.onDocChange ?? false;
        abort = () => {
          aborted = true;
          listener();
        };
      },
    } as unknown as CompletionContext;
    const source = createSqlMetadataCompletionSource({
      cache: createDbMetadataCache({ sessionId: "s1" }),
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    const resultPromise = source(context);
    expect(abortOnDocChange).toBe(true);
    abort();
    pending.resolve([{ name: "orders", kind: "table", rowCount: null }]);

    await expect(resultPromise).resolves.toBeNull();
  });

  it("suggests tables after schema dot", async () => {
    const result = await complete("select * from sales.‸", {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["orders", "orders_v"]);
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith("s1", "sales", null, "", 500);
  });

  it("suggests columns after table dot in the active schema", async () => {
    const result = await complete("select orders.‸ from orders", {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["id", "total"]);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledWith("s1", "public", "orders", null);
  });

  it("supports Presto catalog.schema.table column completion", async () => {
    const result = await complete("select hive.sales.orders.‸", {
      engine: "Presto",
      activeSchema: "default",
      catalog: "hive",
    });

    expect(labels(result)).toEqual(["id", "total"]);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledWith("s1", "sales", "orders", "hive");
  });

  it("supports Presto catalog.schema table completion", async () => {
    const result = await complete("select hive.sales.o‸", {
      engine: "Presto",
      activeSchema: "default",
      catalog: "hive",
    });

    expect(labels(result)).toEqual(["orders", "orders_v"]);
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith("s1", "sales", "hive", "o", 500);
  });

  it("resolves simple FROM/JOIN aliases to table columns", async () => {
    const result = await complete("select o.‸ from sales.orders as o join customers c on c.id = o.id", {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(labels(result)).toEqual(["id", "total"]);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledWith("s1", "sales", "orders", null);
  });

  it("leaves CTE column completion to the local structured source", async () => {
    const result = await complete(`
      WITH recent AS (SELECT id, total FROM orders)
      SELECT recent.‸ FROM recent
    `, {
      engine: "PostgreSQL",
      activeSchema: "public",
    });

    expect(result).toBeNull();
    expect(ipcMock.dbSearchTables).not.toHaveBeenCalled();
    expect(ipcMock.dbDescribeTable).not.toHaveBeenCalled();
  });

  it("deduplicates metadata requests across concurrent completions", async () => {
    const cache = createDbMetadataCache({ sessionId: "s1" });

    const [first, second] = await Promise.all([
      complete("select orders.‸ from orders", {
        engine: "PostgreSQL",
        activeSchema: "public",
        cache,
      }),
      complete("select orders.‸ from orders", {
        engine: "PostgreSQL",
        activeSchema: "public",
        cache,
      }),
    ]);

    expect(labels(first)).toEqual(["id", "total"]);
    expect(labels(second)).toEqual(["id", "total"]);
    expect(ipcMock.dbSearchTables).toHaveBeenCalledTimes(1);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledTimes(1);
  });

  it("caps object completion results at 500 entries", async () => {
    const onResult = vi.fn();
    ipcMock.dbSearchTables.mockResolvedValueOnce(
      Array.from({ length: 650 }, (_, index) => ({
        name: `tbl_${String(index).padStart(3, "0")}`,
        kind: "table",
        rowCount: null,
      })),
    );

    const result = await complete("select bulk.tbl‸", {
      engine: "MySQL",
      activeSchema: null,
      onResult,
    });

    expect(result?.options).toHaveLength(DB_METADATA_COMPLETION_LIMIT);
    expect(labels(result).at(0)).toBe("tbl_000");
    expect(labels(result).at(-1)).toBe("tbl_499");
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith("s1", "bulk", null, "tbl", 500);
    expect(onResult).toHaveBeenCalledWith({ count: 500, limitReached: true });
  });
});

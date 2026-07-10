import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbMetadataCache, sqlMetadataInvalidationTarget } from "./dbMetadataCache";

const ipcMock = vi.hoisted(() => ({
  dbListCatalogs: vi.fn(async () => [{ name: "hive" }]),
  dbListSchemas: vi.fn(async () => [{ name: "public" }]),
  dbListTables: vi.fn(async () => [{ name: "orders", kind: "table", rowCount: null }]),
  dbSearchTables: vi.fn(async () => [{ name: "orders", kind: "table", rowCount: null }]),
  dbDescribeTable: vi.fn(async () => [
    { name: "id", type: "int", nullable: false, default: null, primaryKey: true },
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("DbMetadataCache", () => {
  it("caches metadata within the TTL and reloads after expiry", async () => {
    let now = 1000;
    const cache = createDbMetadataCache({
      sessionId: "s1",
      ttlMs: 100,
      now: () => now,
    });

    expect(await cache.listSchemas()).toEqual(["public"]);
    expect(await cache.listSchemas()).toEqual(["public"]);
    expect(ipcMock.dbListSchemas).toHaveBeenCalledTimes(1);

    now = 1200;
    expect(await cache.listSchemas()).toEqual(["public"]);
    expect(ipcMock.dbListSchemas).toHaveBeenCalledTimes(2);
  });

  it("does not expose expired entries through synchronous peeks", async () => {
    let now = 1000;
    const cache = createDbMetadataCache({
      sessionId: "s1",
      ttlMs: 100,
      now: () => now,
    });

    await cache.listSchemas();
    expect(cache.peekSchemas()).toEqual(["public"]);

    now = 1101;
    expect(cache.peekSchemas()).toBeNull();
  });

  it("deduplicates in-flight metadata requests", async () => {
    const pending = deferred<Array<{ name: string; kind: "table"; rowCount: null }>>();
    ipcMock.dbListTables.mockReturnValueOnce(pending.promise);
    const cache = createDbMetadataCache({ sessionId: "s1" });

    const first = cache.listTables("public");
    const second = cache.listTables("public");
    pending.resolve([{ name: "orders", kind: "table", rowCount: null }]);

    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(ipcMock.dbListTables).toHaveBeenCalledTimes(1);
  });

  it("uses bounded table search when a full schema listing is not cached", async () => {
    const cache = createDbMetadataCache({ sessionId: "s1" });

    await expect(cache.searchTables("public", "ord", null, 25)).resolves.toEqual([
      { name: "orders", kind: "table", rowCount: null },
    ]);
    await cache.searchTables("public", "ord", null, 25);

    expect(ipcMock.dbSearchTables).toHaveBeenCalledTimes(1);
    expect(ipcMock.dbSearchTables).toHaveBeenCalledWith("s1", "public", null, "ord", 25);
    expect(ipcMock.dbListTables).not.toHaveBeenCalled();
  });

  it("filters a cached full schema listing without another IPC request", async () => {
    ipcMock.dbListTables.mockResolvedValueOnce([
      { name: "orders", kind: "table", rowCount: null },
      { name: "customers", kind: "table", rowCount: null },
    ]);
    const cache = createDbMetadataCache({ sessionId: "s1" });
    await cache.listTables("public");

    await expect(cache.searchTables("public", "ord", null, 10)).resolves.toEqual([
      { name: "orders", kind: "table", rowCount: null },
    ]);
    expect(ipcMock.dbSearchTables).not.toHaveBeenCalled();
  });

  it("clears schema and column entries on manual invalidation", async () => {
    const cache = createDbMetadataCache({ sessionId: "s1" });
    await cache.listTables("public");
    await cache.describeTable("public", "orders");
    expect(ipcMock.dbListTables).toHaveBeenCalledTimes(1);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledTimes(1);

    cache.invalidate({ schema: "public" });
    await cache.listTables("public");
    await cache.describeTable("public", "orders");
    expect(ipcMock.dbListTables).toHaveBeenCalledTimes(2);
    expect(ipcMock.dbDescribeTable).toHaveBeenCalledTimes(2);
  });

  it("does not let an invalidated request overwrite replacement metadata", async () => {
    const pending = deferred<Array<{ name: string; kind: "table"; rowCount: null }>>();
    ipcMock.dbListTables
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([{ name: "orders_v2", kind: "table", rowCount: null }]);
    const cache = createDbMetadataCache({ sessionId: "s1" });

    const staleRequest = cache.listTables("public");
    cache.invalidate({ schema: "public" });
    await expect(cache.listTables("public")).resolves.toEqual([
      { name: "orders_v2", kind: "table", rowCount: null },
    ]);

    pending.resolve([{ name: "orders_v1", kind: "table", rowCount: null }]);
    await expect(staleRequest).resolves.toEqual([
      { name: "orders_v1", kind: "table", rowCount: null },
    ]);

    expect(cache.peekTables("public")).toEqual([
      { name: "orders_v2", kind: "table", rowCount: null },
    ]);
    await cache.listTables("public");
    expect(ipcMock.dbListTables).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight request repopulate a cleared cache", async () => {
    const pending = deferred<Array<{ name: string }>>();
    ipcMock.dbListSchemas
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([{ name: "reporting" }]);
    const cache = createDbMetadataCache({ sessionId: "s1" });

    const staleRequest = cache.listSchemas();
    cache.clearAll();
    await expect(cache.listSchemas()).resolves.toEqual(["reporting"]);

    pending.resolve([{ name: "public" }]);
    await expect(staleRequest).resolves.toEqual(["public"]);

    expect(cache.peekSchemas()).toEqual(["reporting"]);
    await cache.listSchemas();
    expect(ipcMock.dbListSchemas).toHaveBeenCalledTimes(2);
  });

  it("parses DDL statements into targeted metadata invalidations", () => {
    expect(
      sqlMetadataInvalidationTarget("ALTER TABLE sales.orders ADD COLUMN note text", {
        engine: "PostgreSQL",
        activeSchema: "public",
      }),
    ).toEqual({ schema: "sales", table: "orders" });

    expect(
      sqlMetadataInvalidationTarget('DROP TABLE "hive"."sales"."orders"', {
        engine: "Presto",
        activeSchema: "default",
        defaultCatalog: "hive",
      }),
    ).toEqual({ catalog: "hive", schema: "sales", table: "orders" });

    expect(
      sqlMetadataInvalidationTarget("CREATE SCHEMA reporting", {
        engine: "MySQL",
        activeSchema: "app",
      }),
    ).toEqual({ all: true });
  });
});

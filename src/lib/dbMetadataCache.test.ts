import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbMetadataCache, sqlMetadataInvalidationTarget } from "./dbMetadataCache";

const ipcMock = vi.hoisted(() => ({
  dbListCatalogs: vi.fn(async () => [{ name: "hive" }]),
  dbListSchemas: vi.fn(async () => [{ name: "public" }]),
  dbListTables: vi.fn(async () => [{ name: "orders", kind: "table", rowCount: null }]),
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

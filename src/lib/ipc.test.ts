import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage: ((message: T) => void) | null = null;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));

import {
  dbConnect,
  dbTestConnection,
  selectFilePath,
  selectFolderPath,
  selectPrivateKeyFile,
  selectSaveDirectory,
  selectSaveFilePath,
  selectUploadFile,
} from "./ipc";
import type { DbConnectInfo } from "../types";

describe("ipc dialog path selectors", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.open.mockReset();
    mocks.save.mockReset();
  });

  it("selects folders through the Tauri dialog plugin", async () => {
    mocks.open.mockResolvedValueOnce("/home/user/project");

    await expect(selectFolderPath("/home/user")).resolves.toBe("/home/user/project");

    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select folder to open",
      directory: true,
      defaultPath: "/home/user",
      multiple: false,
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("select_folder_path", expect.anything());
  });

  it("selects files through the Tauri dialog plugin", async () => {
    mocks.open.mockResolvedValueOnce("/home/user/.ssh/config");

    await expect(selectFilePath("/home/user/.ssh")).resolves.toBe("/home/user/.ssh/config");

    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select file to open",
      directory: false,
      defaultPath: "/home/user/.ssh",
      multiple: false,
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("select_file_path", expect.anything());
  });

  it("keeps private key selection open to extensionless files", async () => {
    mocks.open.mockResolvedValueOnce("/home/user/.ssh/id_ed25519");

    await expect(selectPrivateKeyFile("~/.ssh/id_ed25519")).resolves.toBe("/home/user/.ssh/id_ed25519");

    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select private key",
      directory: false,
      defaultPath: "~/.ssh/id_ed25519",
      multiple: false,
    });
  });

  it("normalizes multi-select upload results", async () => {
    mocks.open.mockResolvedValueOnce(["/tmp/a.txt", "", "/tmp/b.txt"]);

    await expect(selectUploadFile()).resolves.toEqual(["/tmp/a.txt", "/tmp/b.txt"]);

    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select files to send",
      multiple: true,
      directory: false,
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("select_upload_file", expect.anything());
  });

  it("selects save directories and save files through the dialog plugin", async () => {
    mocks.open.mockResolvedValueOnce("/home/user/downloads");
    mocks.save.mockResolvedValueOnce("/home/user/report.csv");

    await expect(selectSaveDirectory("/home/user")).resolves.toBe("/home/user/downloads");
    await expect(selectSaveFilePath("report.csv", "/home/user/old-export.json")).resolves.toBe("/home/user/report.csv");

    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select save directory",
      directory: true,
      defaultPath: "/home/user",
      multiple: false,
    });
    expect(mocks.save).toHaveBeenCalledWith({
      title: "Save as",
      defaultPath: "/home/user/report.csv",
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("select_save_directory", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("select_save_file_path", expect.anything());
  });
});

describe("ipc dbConnect payload", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  const basePrestoInfo = (): DbConnectInfo => ({
    sessionId: "sess-presto-1",
    engine: "Presto",
    host: "trino.example.com",
    port: 8080,
    username: "analyst",
    password: "secret",
    catalog: "hive",
    database: "sales",
    ssl: true,
    timeoutSecs: 30,
    httpPort: null,
    protocol: null,
    prestoDialect: "trino",
    dbIndex: null,
    networkSettings: null,
  });

  it("forwards prestoDialect through dbConnect config to the Rust db_connect command", async () => {
    mocks.invoke.mockResolvedValueOnce({ ok: true });

    await dbConnect(basePrestoInfo());

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("db_connect", {
      sessionId: "sess-presto-1",
      config: expect.objectContaining({
        engine: "Presto",
        host: "trino.example.com",
        port: 8080,
        username: "analyst",
        password: "secret",
        catalog: "hive",
        database: "sales",
        ssl: true,
        timeoutSecs: 30,
        // Critical: dialect must reach DbConfig.presto_dialect (camelCase over IPC).
        prestoDialect: "trino",
      }),
    });
    // Frontend-only sessionId must not be nested inside config.
    const config = mocks.invoke.mock.calls[0][1].config as Record<string, unknown>;
    expect(config).not.toHaveProperty("sessionId");
  });

  it("defaults missing prestoDialect to null so legacy Presto sessions stay Presto-headered", async () => {
    mocks.invoke.mockResolvedValueOnce({ ok: true });
    const info = basePrestoInfo();
    delete info.prestoDialect;

    await dbConnect(info);

    const config = mocks.invoke.mock.calls[0][1].config as Record<string, unknown>;
    expect(config.prestoDialect).toBeNull();
  });

  it("forwards prestoDialect on the test-connection path (dbConnect probe)", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ ok: true }) // db_connect
      .mockResolvedValueOnce("Presto connection OK") // db_ping
      .mockResolvedValueOnce(undefined); // db_disconnect

    await expect(dbTestConnection(basePrestoInfo())).resolves.toBe("Presto connection OK");

    const connectCall = mocks.invoke.mock.calls.find((call) => call[0] === "db_connect");
    expect(connectCall).toBeDefined();
    expect(connectCall![1].config).toMatchObject({
      engine: "Presto",
      catalog: "hive",
      prestoDialect: "trino",
    });
  });
});

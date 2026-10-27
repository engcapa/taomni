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

  it("starts an empty folder chooser at the native home and preserves cancellation", async () => {
    mocks.invoke.mockResolvedValueOnce("/home/user");
    mocks.open.mockResolvedValueOnce(null);
    await expect(selectFolderPath()).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("get_home_dir", {});
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/home/user" }));
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

describe("IPC retained async boundaries", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.listen.mockReset(); });

  it("normalizes legacy directory arrays and keeps the envelope revision", async () => {
    const { listCommonLocalDirectories } = await import("./ipc");
    mocks.invoke.mockResolvedValueOnce([{ path: "/tmp/project" }, { path: "" }, null]);
    const legacy = await listCommonLocalDirectories();
    expect(legacy.revision).toBe(0);
    expect(legacy.directories).toEqual([expect.objectContaining({ path: "/tmp/project", availability: "unknown" })]);
    mocks.invoke.mockResolvedValueOnce({ revision: 7, directories: [{ path: "/tmp/project", lastUsedAtMs: 123 }] });
    expect(await listCommonLocalDirectories()).toMatchObject({ revision: 7, directories: [{ lastUsedAtMs: 123 }] });
  });

  it("keeps terminal output binary and subscribes to the requested session only", async () => {
    const { createLocalTerminal, listenTerminalExit } = await import("./ipc");
    const onOutput = vi.fn();
    mocks.invoke.mockResolvedValueOnce({ sessionId: "a", shellId: "bash", taskEnvironment: {} });
    await createLocalTerminal("a", 80, 24, "bash", [], "/tmp", onOutput);
    const channel = mocks.invoke.mock.calls[0][1].onOutput;
    channel.onmessage(Uint8Array.from([0, 127, 255]).buffer);
    expect(onOutput).toHaveBeenCalledWith(Uint8Array.from([0, 127, 255]));
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const onExit = vi.fn();
    expect(await listenTerminalExit("a", onExit)).toBe(unlisten);
    expect(mocks.listen.mock.calls[0][0]).toBe("terminal-exit-a");
    mocks.listen.mock.calls[0][1]({ payload: null });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("emits the vault notification and rethrows the original connection error", async () => {
    const { dbConnect, VAULT_LOCKED_EVENT } = await import("./ipc");
    const error = new Error("VAULT_LOCKED");
    const notice = vi.fn();
    window.addEventListener(VAULT_LOCKED_EVENT, notice);
    mocks.invoke.mockRejectedValueOnce(error);
    try {
      await expect(dbConnect({ sessionId: "a", engine: "MySQL", host: "localhost", port: 3306 })).rejects.toBe(error);
      expect(notice).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener(VAULT_LOCKED_EVENT, notice); }
  });

  it("disconnects a failed probe even if cleanup itself fails", async () => {
    const failure = new Error("ping failed");
    mocks.invoke.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error("close failed"));
    await expect(dbTestConnection({ sessionId: "live", engine: "MySQL", host: "localhost", port: 3306 })).rejects.toBe(failure);
    const probeId = mocks.invoke.mock.calls[0][1].sessionId;
    expect(probeId).not.toBe("live");
    expect(mocks.invoke.mock.calls.at(-1)).toEqual(["db_disconnect", { sessionId: probeId }]);
  });
});

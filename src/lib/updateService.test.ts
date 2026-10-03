import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined,
  ),
  relaunch: vi.fn(async () => undefined),
  check: vi.fn(),
  download: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));

vi.mock("./runtime", () => ({
  getAppPlatform: () => "linux",
  isTauriRuntime: () => true,
}));

import {
  checkForUpdate,
  downloadAndInstall,
  installDownloadedUpdate,
  isSocksCapUpgradeAuthorizationRequired,
  relaunchApp,
} from "./updateService";

const update = {
  version: "0.4.4",
  currentVersion: "0.4.3",
  body: "test update",
  close: mocks.close,
  download: mocks.download,
  install: mocks.install,
};

describe("updateService.relaunchApp", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.relaunch.mockReset();
    mocks.relaunch.mockResolvedValue(undefined);
    mocks.check.mockReset();
    mocks.check.mockResolvedValue(update);
    mocks.download.mockReset();
    mocks.download.mockResolvedValue(undefined);
    mocks.install.mockReset();
    mocks.install.mockResolvedValue(undefined);
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
  });

  it("detaches a cancelled download handle from a fresh check and never installs its late bytes", async () => {
    let deliver: (event: import("@tauri-apps/plugin-updater").DownloadEvent) => void = () => {};
    let finish = () => {};
    const old = {
      ...update,
      close: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      download: vi.fn((callback: (event: import("@tauri-apps/plugin-updater").DownloadEvent) => void) => {
        deliver = callback;
        return new Promise<void>((resolve) => { finish = resolve; });
      }),
    };
    const fresh = { ...update, close: vi.fn(async () => undefined), download: vi.fn(async () => undefined), install: vi.fn(async () => undefined) };
    mocks.check.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
    await checkForUpdate("darwin-aarch64");
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = downloadAndInstall("darwin-aarch64", progress, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    deliver({ event: "Started", data: { contentLength: 100 } });
    deliver({ event: "Progress", data: { chunkLength: 10 } });
    controller.abort();
    await checkForUpdate("darwin-aarch64");
    expect(old.close).not.toHaveBeenCalled();
    deliver({ event: "Progress", data: { chunkLength: 90 } });
    deliver({ event: "Finished" });
    expect(progress).toHaveBeenCalledTimes(2);
    await downloadAndInstall("darwin-aarch64", vi.fn());
    finish();
    await rejection;
    expect(old.install).not.toHaveBeenCalled();
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(fresh.install).toHaveBeenCalledTimes(1);
  });

  it("reuses the selected target with the application proxy for check and download", async () => {
    mocks.invoke.mockResolvedValue("http://127.0.0.1:3228");
    await checkForUpdate("darwin-x86_64");
    await downloadAndInstall("darwin-x86_64", vi.fn());
    expect(mocks.check).toHaveBeenCalledWith({ target: "darwin-x86_64", proxy: "http://127.0.0.1:3228" });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it("does not start an already-cancelled download or stop SocksCap", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadAndInstall(undefined, vi.fn(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("gracefully tears down SocksCap before relaunching on Linux", async () => {
    await relaunchApp();

    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_prepare_for_update", {
      sudoPassword: undefined,
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.relaunch.mock.invocationCallOrder[0],
    );
  });

  it("does not relaunch when SocksCap network cleanup fails", async () => {
    mocks.invoke.mockRejectedValueOnce("Linux capture teardown failed");

    await expect(relaunchApp()).rejects.toBe("Linux capture teardown failed");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("does not install an update when pre-install network cleanup fails", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "sockscap_prepare_for_update") {
        throw new Error("Linux capture teardown failed");
      }
      return null;
    });
    await checkForUpdate();

    await expect(downloadAndInstall(undefined, vi.fn())).rejects.toThrow(
      "Linux capture teardown failed",
    );

    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("resumes a downloaded Linux update after automatic recovery gets sudo authorization", async () => {
    await checkForUpdate();
    mocks.invoke.mockRejectedValueOnce(
      "SOCKSCAP_UPDATE_SUDO_REQUIRED: automatic SocksCap recovery failed",
    );

    const initialInstall = downloadAndInstall(undefined, vi.fn());
    await expect(initialInstall).rejects.toSatisfy(isSocksCapUpgradeAuthorizationRequired);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).not.toHaveBeenCalled();

    await installDownloadedUpdate(undefined, "root-secret");

    expect(mocks.invoke).toHaveBeenLastCalledWith("sockscap_prepare_for_update", {
      sudoPassword: "root-secret",
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });
});

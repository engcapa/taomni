import { beforeEach, describe, expect, it, vi } from "vitest";

// The service layer talks to Tauri plugins; mock it so the store logic can be
// tested in isolation.
vi.mock("../lib/updateService", () => ({
  getUpdaterPlatform: vi.fn(),
  checkForUpdate: vi.fn(),
  downloadAndInstall: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  discardDownloadedUpdate: vi.fn(async () => undefined),
  isSocksCapUpgradeAuthorizationRequired: vi.fn((error: unknown) =>
    String(error).includes("SOCKSCAP_UPDATE_SUDO_REQUIRED:"),
  ),
  isSudoAuthenticationError: vi.fn((error: unknown) =>
    String(error).includes("sudo authentication failed"),
  ),
  relaunchApp: vi.fn(),
}));

import { useUpdateStore } from "./updateStore";
import * as svc from "../lib/updateService";

const mocked = vi.mocked(svc);
const get = () => useUpdateStore.getState();

const platform = (over: Partial<svc.UpdaterPlatform> = {}): svc.UpdaterPlatform => ({
  os: "darwin",
  nativeTarget: "darwin-aarch64",
  recommendedTarget: "darwin-aarch64",
  candidates: ["darwin-aarch64", "darwin-x86_64"],
  isRosetta: false,
  ...over,
});

const update = (over: Partial<svc.AvailableUpdate> = {}): svc.AvailableUpdate => ({
  version: "0.2.14",
  currentVersion: "0.2.13",
  notes: "Notes",
  ...over,
});

beforeEach(() => {
  get().reset();
  vi.clearAllMocks();
  useUpdateStore.setState({
    status: "idle",
    dialogOpen: false,
    manual: false,
    availableVersion: null,
    currentVersion: null,
    notes: "",
    error: null,
    progress: null,
    authorizationBusy: false,
    authorizationError: null,
    os: null,
    nativeTarget: null,
    recommendedTarget: null,
    candidates: [],
    isRosetta: false,
    selectedTarget: null,
    targetStatus: "unknown",
  });
});

describe("updateStore.check", () => {
  it("startup check with no update stays quiet (no dialog)", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(null);
    await get().check();
    expect(get().status).toBe("uptodate");
    expect(get().dialogOpen).toBe(false);
  });

  it("manual check with no update opens the dialog to report it", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(null);
    await get().check({ manual: true });
    expect(get().status).toBe("uptodate");
    expect(get().dialogOpen).toBe(true);
  });

  it("surfaces an available update without auto-opening the window (startup)", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check();
    const s = get();
    expect(s.status).toBe("available");
    expect(s.availableVersion).toBe("0.2.14");
    expect(s.notes).toBe("Notes");
    expect(s.selectedTarget).toBe("darwin-aarch64");
    expect(s.targetStatus).toBe("ok");
    expect(s.dialogOpen).toBe(false); // non-intrusive: indicator only
    expect(mocked.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(mocked.checkForUpdate).toHaveBeenCalledWith("darwin-aarch64");
  });

  it("uses undefined target for checking on single-candidate platforms (like Windows/Linux)", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(
      platform({ os: "linux", nativeTarget: "linux-x86_64", recommendedTarget: "linux-x86_64", candidates: ["linux-x86_64"] }),
    );
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check();
    expect(mocked.checkForUpdate).toHaveBeenCalledWith(undefined);
  });

  it("opens the window for an available update on a manual check", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check({ manual: true });
    const s = get();
    expect(s.status).toBe("available");
    expect(s.dialogOpen).toBe(true);
  });

  it("under Rosetta, recommends and validates the native arm64 build", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(
      platform({ nativeTarget: "darwin-x86_64", recommendedTarget: "darwin-aarch64", isRosetta: true }),
    );
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check();
    const s = get();
    expect(s.status).toBe("available");
    expect(s.selectedTarget).toBe("darwin-aarch64");
    expect(s.targetStatus).toBe("ok");
    expect(mocked.checkForUpdate).toHaveBeenCalledWith("darwin-x86_64");
    expect(mocked.checkForUpdate).toHaveBeenCalledWith("darwin-aarch64");
  });

  it("reports errors and opens the dialog on a manual check", async () => {
    mocked.getUpdaterPlatform.mockRejectedValue(new Error("nope"));
    await get().check({ manual: true });
    expect(get().status).toBe("error");
    expect(get().error).toBe("nope");
    expect(get().dialogOpen).toBe(true);
  });

  it("opens the dialog immediately while a manual check is in flight", async () => {
    let resolvePlatform: (p: svc.UpdaterPlatform) => void = () => {};
    mocked.getUpdaterPlatform.mockReturnValue(
      new Promise<svc.UpdaterPlatform>((resolve) => {
        resolvePlatform = resolve;
      }),
    );
    mocked.checkForUpdate.mockResolvedValue(null);

    const pending = get().check({ manual: true });
    // Before the network round-trip resolves, the dialog is already showing
    // the "checking" state so the user gets instant feedback.
    expect(get().status).toBe("checking");
    expect(get().dialogOpen).toBe(true);

    resolvePlatform(platform({ os: "linux", nativeTarget: "linux-x86_64", recommendedTarget: "linux-x86_64", candidates: ["linux-x86_64"] }));
    await pending;
    expect(get().status).toBe("uptodate");
  });

  it("does not start a second check while one is already in flight", async () => {
    useUpdateStore.setState({ status: "checking", dialogOpen: false });
    await get().check({ manual: true });
    // Re-triggering during a check just re-surfaces the dialog; no duplicate
    // network calls are made.
    expect(get().dialogOpen).toBe(true);
    expect(mocked.getUpdaterPlatform).not.toHaveBeenCalled();
    expect(mocked.checkForUpdate).not.toHaveBeenCalled();
  });

  it("an auto check no-ops while a check is already in flight", async () => {
    useUpdateStore.setState({ status: "checking", dialogOpen: false });
    await get().check();
    expect(get().dialogOpen).toBe(false);
    expect(mocked.getUpdaterPlatform).not.toHaveBeenCalled();
  });
});

describe("updateStore.setSelectedTarget", () => {
  it("flags a target with no build for this version as unavailable", async () => {
    useUpdateStore.setState({ status: "available", selectedTarget: "darwin-aarch64", targetStatus: "ok" });
    mocked.checkForUpdate.mockResolvedValue(null);
    await get().setSelectedTarget("darwin-x86_64");
    expect(get().selectedTarget).toBe("darwin-x86_64");
    expect(get().targetStatus).toBe("unavailable");
  });

  it("accepts a valid target and refreshes the version info", async () => {
    mocked.checkForUpdate.mockResolvedValue(update({ version: "0.2.15" }));
    await get().setSelectedTarget("darwin-x86_64");
    expect(get().targetStatus).toBe("ok");
    expect(get().availableVersion).toBe("0.2.15");
  });
});

describe("updateStore.startDownload", () => {
  it("ignores the old download after cancel, check and retry, including late progress and completion", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(update());
    const jobs: { progress: (p: svc.DownloadProgress) => void; finish: () => void }[] = [];
    mocked.downloadAndInstall.mockImplementation((_target, progress) => new Promise<void>((finish) => {
      jobs.push({ progress, finish });
    }));
    await get().check({ manual: true });
    const first = get().startDownload();
    jobs[0].progress({ downloaded: 20, total: 100, percent: 20 });
    get().cancelDownload();
    expect(get().status).toBe("available");
    expect(get().progress).toBeNull();
    await get().check({ manual: true });
    const second = get().startDownload();
    jobs[1].progress({ downloaded: 60, total: 100, percent: 60 });
    jobs[0].progress({ downloaded: 30, total: 100, percent: 30 });
    expect(get().progress?.percent).toBe(60);
    jobs[0].finish();
    await first;
    expect(get().status).toBe("downloading");
    jobs[1].progress({ downloaded: 100, total: 100, percent: 100 });
    jobs[1].finish();
    await second;
    expect(get().status).toBe("ready");
  });

  it("does not dismiss a live download/install/authorization without its explicit action", () => {
    for (const status of ["downloading", "installing", "authorizing"] as const) {
      useUpdateStore.setState({ status, dialogOpen: true });
      get().closeDialog();
      expect(get().dialogOpen).toBe(true);
    }
    useUpdateStore.setState({ status: "ready" });
    get().closeDialog();
    expect(get().dialogOpen).toBe(false);
  });

  it("does not replace an active download with check, target changes or duplicate download", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check();
    let finish = () => {};
    mocked.downloadAndInstall.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = get().startDownload();
    await get().check({ manual: true });
    await get().setSelectedTarget("darwin-x86_64");
    await get().startDownload();
    expect(get().dialogOpen).toBe(true);
    expect(get().status).toBe("downloading");
    expect(get().selectedTarget).toBe("darwin-aarch64");
    expect(mocked.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocked.checkForUpdate).toHaveBeenCalledTimes(1);
    finish();
    await pending;
  });

  it("ignores late failure from a cancelled download and refuses unvalidated packages", async () => {
    mocked.getUpdaterPlatform.mockResolvedValue(platform());
    mocked.checkForUpdate.mockResolvedValue(update());
    await get().check();
    let fail: (e: Error) => void = () => {};
    mocked.downloadAndInstall.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const pending = get().startDownload();
    get().cancelDownload();
    fail(new Error("late failure"));
    await pending;
    expect(get().status).toBe("available");
    expect(get().error).toBeNull();
    useUpdateStore.setState({ targetStatus: "checking" });
    await get().startDownload();
    expect(mocked.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("installs the selected target and reports progress, ending ready", async () => {
    useUpdateStore.setState({
      status: "available",
      targetStatus: "ok",
      selectedTarget: "darwin-aarch64",
      candidates: ["darwin-aarch64", "darwin-x86_64"],
    });
    mocked.downloadAndInstall.mockImplementation(async (_t, onProgress) => {
      onProgress({ downloaded: 50, total: 100, percent: 50 });
    });
    await get().startDownload();
    expect(mocked.downloadAndInstall).toHaveBeenCalledWith("darwin-aarch64", expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get().status).toBe("ready");
    expect(get().progress).toEqual({ downloaded: 50, total: 100, percent: 50 });
  });

  it("installs with undefined target on single-candidate platforms (like Windows/Linux)", async () => {
    useUpdateStore.setState({
      status: "available",
      targetStatus: "ok",
      selectedTarget: "linux-x86_64",
      candidates: ["linux-x86_64"],
    });
    mocked.downloadAndInstall.mockImplementation(async (_t, onProgress) => {
      onProgress({ downloaded: 50, total: 100, percent: 50 });
    });
    await get().startDownload();
    expect(mocked.downloadAndInstall).toHaveBeenCalledWith(undefined, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("moves to error state when the download fails", async () => {
    useUpdateStore.setState({
      status: "available",
      targetStatus: "ok",
      selectedTarget: "darwin-aarch64",
      candidates: ["darwin-aarch64", "darwin-x86_64"],
    });
    mocked.downloadAndInstall.mockRejectedValue(new Error("boom"));
    await get().startDownload();
    expect(get().status).toBe("error");
    expect(get().error).toBe("boom");
  });

  it("requests sudo authorization and resumes the already-downloaded Linux update", async () => {
    useUpdateStore.setState({
      status: "available",
      targetStatus: "ok",
      os: "linux",
      selectedTarget: "linux-x86_64",
      candidates: ["linux-x86_64"],
    });
    mocked.downloadAndInstall.mockRejectedValue(
      new Error("SOCKSCAP_UPDATE_SUDO_REQUIRED: stale capture state"),
    );

    await get().startDownload();

    expect(get().status).toBe("authorizing");
    expect(mocked.installDownloadedUpdate).not.toHaveBeenCalled();

    mocked.installDownloadedUpdate.mockResolvedValue(undefined);
    await get().authorizeInstall("root-secret");

    expect(mocked.installDownloadedUpdate).toHaveBeenCalledWith(undefined, "root-secret");
    expect(mocked.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(get().status).toBe("ready");
  });

  it("keeps the authorization prompt open after an incorrect sudo password", async () => {
    useUpdateStore.setState({
      status: "authorizing",
      os: "linux",
      selectedTarget: "linux-x86_64",
      candidates: ["linux-x86_64"],
    });
    mocked.installDownloadedUpdate.mockRejectedValue(
      new Error("sudo authentication failed: Sorry, try again"),
    );

    await get().authorizeInstall("incorrect");

    expect(get().status).toBe("authorizing");
    expect(get().authorizationBusy).toBe(false);
    expect(get().authorizationError).toBe("Sudo password incorrect or authentication failed. Please try again.");
  });
});

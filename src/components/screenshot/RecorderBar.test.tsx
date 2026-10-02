import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingFile } from "../../lib/screenshot";
import { formatElapsed, RecorderBar } from "./RecorderBar";

type RecordingEnded = { recordingId: string; error: string | null };
type EndListener = (event: { payload: RecordingEnded }) => void;

const mocks = vi.hoisted(() => ({
  currentRecording: vi.fn<() => Promise<string | null>>(),
  stopRecording: vi.fn<(id: string) => Promise<RecordingFile>>(),
  cancelRecording: vi.fn<(id: string) => Promise<void>>(),
  loadScreenshotUrl: vi.fn<(path: string) => Promise<string>>(),
  revokeScreenshotUrl: vi.fn<(url: string | null | undefined) => void>(),
  closeOverlay: vi.fn<() => Promise<void>>(),
  closeWindow: vi.fn<() => Promise<void>>(),
  setSize: vi.fn<(size: { width: number; height: number }) => Promise<void>>(),
  saveFile: vi.fn<(path: string, dest: string) => Promise<void>>(),
  copyImage: vi.fn<(path: string) => Promise<void>>(),
  saveDialog: vi.fn<(options: unknown) => Promise<string | null>>(),
  listen: vi.fn<(name: string, listener: EndListener) => Promise<() => void>>(),
  unlisten: vi.fn<() => void>(),
  fetch: vi.fn<(url: string) => Promise<{ blob: () => Promise<Blob> }>>(),
  translate: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("../../lib/i18n", () => ({ useT: () => mocks.translate }));
vi.mock("../../lib/screenshot", () => ({
  RECORDING_ENDED_EVENT: "screenshot://recording-ended",
  currentRecording: mocks.currentRecording,
  stopRecording: mocks.stopRecording,
  cancelRecording: mocks.cancelRecording,
  loadScreenshotUrl: mocks.loadScreenshotUrl,
  revokeScreenshotUrl: mocks.revokeScreenshotUrl,
  closeScreenshotOverlay: mocks.closeOverlay,
  saveImageToFile: mocks.saveFile,
  copyImageToClipboard: mocks.copyImage,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  getCurrentWindow: () => ({ setSize: mocks.setSize, close: mocks.closeWindow }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.saveDialog }));

const gif: RecordingFile = {
  path: "C:/unit-fixture/recording.gif",
  width: 640,
  height: 480,
  frames: 30,
  durationMs: 2_500,
};
const mp4: RecordingFile = { ...gif, path: "C:/unit-fixture/recording.MP4" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderReady() {
  const view = render(<RecorderBar />);
  await waitFor(() => expect(screen.getByTestId("screenshot-recorder-stop")).toBeEnabled());
  await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
  return view;
}

async function stopToPreview(file = gif) {
  mocks.stopRecording.mockResolvedValueOnce(file);
  await renderReady();
  fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
  await screen.findByTestId("screenshot-recorder-preview");
}

function emitEnded(recordingId = "recording-1", error: string | null = null) {
  const listener = mocks.listen.mock.calls.at(-1)?.[1];
  expect(listener).toBeDefined();
  act(() => listener?.({ payload: { recordingId, error } }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentRecording.mockResolvedValue("recording-1");
  mocks.stopRecording.mockResolvedValue(gif);
  mocks.cancelRecording.mockResolvedValue(undefined);
  mocks.closeOverlay.mockResolvedValue(undefined);
  mocks.closeWindow.mockResolvedValue(undefined);
  mocks.setSize.mockResolvedValue(undefined);
  mocks.loadScreenshotUrl.mockResolvedValue("blob:unit-preview");
  mocks.fetch.mockResolvedValue({ blob: async () => new Blob([new Uint8Array(2048)]) });
  mocks.saveFile.mockResolvedValue(undefined);
  mocks.copyImage.mockResolvedValue(undefined);
  mocks.saveDialog.mockResolvedValue(null);
  mocks.listen.mockResolvedValue(mocks.unlisten);
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// These mounted jsdom tests exercise renderer state and mocked IPC contracts,
// not native recording, encoded pixels, the OS clipboard, or file dialogs.
describe("RecorderBar initialization and timer", () => {
  it("disables Stop until initialization resolves and shows the running timer", async () => {
    const init = deferred<string | null>();
    mocks.currentRecording.mockReturnValue(init.promise);
    render(<RecorderBar />);
    expect(screen.getByTestId("screenshot-recorder-stop")).toBeDisabled();
    expect(screen.getByTestId("screenshot-recorder-timer")).toHaveTextContent("00:00");
    await act(async () => init.resolve("recording-1"));
    expect(screen.getByTestId("screenshot-recorder-stop")).toBeEnabled();
    expect(mocks.currentRecording).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledWith("screenshot://recording-ended", expect.any(Function));
  });

  it("ticks from initialization (including epoch zero) and clears its interval on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { unmount } = render(<RecorderBar />);
    await act(async () => { await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(61_250));
    expect(screen.getByTestId("screenshot-recorder-timer")).toHaveTextContent("01:01");
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["idle", "rejected"])("shows safe Cancel when initialization is %s", async (mode) => {
    if (mode === "idle") mocks.currentRecording.mockResolvedValue(null);
    else mocks.currentRecording.mockRejectedValue(new Error("IPC unavailable"));
    render(<RecorderBar />);
    expect(await screen.findByTestId("screenshot-recorder-error")).toHaveTextContent("screenshot.noRecording");
    expect(screen.queryByTestId("screenshot-recorder-stop")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-recorder-cancel"));
    await waitFor(() => expect(mocks.closeOverlay).toHaveBeenCalledTimes(1));
    expect(mocks.cancelRecording).not.toHaveBeenCalled();
  });

  it("ignores initialization that completes after unmount", async () => {
    const init = deferred<string | null>();
    mocks.currentRecording.mockReturnValue(init.promise);
    const { unmount } = render(<RecorderBar />);
    unmount();
    await act(async () => init.resolve("recording-1"));
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.stopRecording).not.toHaveBeenCalled();
  });

  it("formats elapsed time without rounding up", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(59.99)).toBe("00:59");
    expect(formatElapsed(3_661)).toBe("61:01");
  });
});

describe("RecorderBar Stop and Cancel", () => {
  it("finalizes only once for repeated Stop clicks and an overlapping end event", async () => {
    const stop = deferred<RecordingFile>();
    mocks.stopRecording.mockReturnValue(stop.promise);
    await renderReady();
    const button = screen.getByTestId("screenshot-recorder-stop");
    fireEvent.click(button);
    fireEvent.click(button);
    emitEnded();
    expect(button).toBeDisabled();
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
    expect(mocks.stopRecording).toHaveBeenCalledWith("recording-1");
    expect(screen.getByText("screenshot.recordFinishing")).toBeInTheDocument();
    await act(async () => stop.resolve(gif));
    expect(await screen.findByTestId("screenshot-recorder-preview")).toHaveAttribute("src", "blob:unit-preview");
    expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 380, height: 300 }));
    expect(await screen.findByTestId("screenshot-recorder-meta")).toHaveTextContent("640×480 · 00:02 · 30 screenshot.frames · 2 KB");
    emitEnded();
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("cancels the active recording once, ignores racing events, and closes", async () => {
    const cancel = deferred<void>();
    mocks.cancelRecording.mockReturnValue(cancel.promise);
    await renderReady();
    const button = screen.getByTestId("screenshot-recorder-cancel");
    fireEvent.click(button);
    fireEvent.click(button);
    emitEnded();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    expect(mocks.cancelRecording).toHaveBeenCalledTimes(1);
    expect(mocks.cancelRecording).toHaveBeenCalledWith("recording-1");
    expect(mocks.stopRecording).not.toHaveBeenCalled();
    expect(mocks.closeOverlay).not.toHaveBeenCalled();
    await act(async () => cancel.resolve());
    expect(mocks.closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("still closes when cancel IPC fails and falls back to the current window", async () => {
    mocks.cancelRecording.mockRejectedValue(new Error("unknown recording id"));
    mocks.closeOverlay.mockRejectedValue(new Error("overlay gone"));
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-cancel"));
    await waitFor(() => expect(mocks.closeWindow).toHaveBeenCalledTimes(1));
  });

  it("shows Stop failure, disables invalid retries, and leaves safe Cancel", async () => {
    mocks.stopRecording.mockRejectedValue(new Error("encoder failed"));
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    expect(await screen.findByTestId("screenshot-recorder-error")).toHaveTextContent("encoder failed");
    expect(screen.getByTestId("screenshot-recorder-error")).toHaveTextContent("screenshot.recordFailed");
    expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 140 }));
    expect(screen.getByTestId("screenshot-recorder-stop")).toBeDisabled();
    expect(screen.queryByText("screenshot.recordFinishing")).not.toBeInTheDocument();
    expect(screen.getByTestId("screenshot-recorder-cancel")).toBeEnabled();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    emitEnded();
    fireEvent.click(screen.getByTestId("screenshot-recorder-cancel"));
    await waitFor(() => expect(mocks.closeOverlay).toHaveBeenCalledTimes(1));
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
    expect(mocks.cancelRecording).not.toHaveBeenCalled();
  });

  it("discards Stop completion after Cancel without loading a preview or stopping again", async () => {
    const stop = deferred<RecordingFile>();
    mocks.stopRecording.mockReturnValue(stop.promise);
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    fireEvent.click(screen.getByTestId("screenshot-recorder-cancel"));
    await waitFor(() => expect(mocks.closeOverlay).toHaveBeenCalledTimes(1));
    await act(async () => stop.resolve(gif));
    expect(mocks.cancelRecording).not.toHaveBeenCalled();
    expect(mocks.setSize).not.toHaveBeenCalledWith(expect.objectContaining({ width: 380, height: 300 }));
    expect(mocks.loadScreenshotUrl).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screenshot-recorder-preview")).not.toBeInTheDocument();
  });
});

describe("RecorderBar preview actions", () => {
  it.each([null, "", "   "])("keeps the preview open when save returns %j", async (destination) => {
    mocks.saveDialog.mockResolvedValue(destination);
    await stopToPreview();
    fireEvent.click(screen.getByTestId("screenshot-recorder-save"));
    await waitFor(() => expect(mocks.saveDialog).toHaveBeenCalledTimes(1));
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.closeOverlay).not.toHaveBeenCalled();
    expect(screen.getByTestId("screenshot-recorder-preview")).toBeInTheDocument();
  });

  it.each([gif, mp4])("saves $path with its matching extension before closing", async (file) => {
    const saved = deferred<void>();
    const ext = file === mp4 ? "mp4" : "gif";
    const destination = `D:/unit-fixture/saved.${ext}`;
    mocks.saveDialog.mockResolvedValue(destination);
    mocks.saveFile.mockReturnValue(saved.promise);
    await stopToPreview(file);
    expect(screen.getByTestId("screenshot-recorder-preview").tagName).toBe(ext === "mp4" ? "VIDEO" : "IMG");
    expect(Boolean(screen.queryByTestId("screenshot-recorder-copy"))).toBe(ext === "gif");
    fireEvent.click(screen.getByTestId("screenshot-recorder-save"));
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledWith(file.path, destination));
    expect(mocks.saveDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "screenshot.save",
      defaultPath: expect.stringMatching(new RegExp(`^Taomni-recording-.*\\.${ext}$`)),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    }));
    expect(mocks.closeOverlay).not.toHaveBeenCalled();
    await act(async () => saved.resolve());
    expect(mocks.closeOverlay).toHaveBeenCalledTimes(1);
    expect(mocks.revokeScreenshotUrl).toHaveBeenCalledWith("blob:unit-preview");
  });

  it("copies GIF via the image IPC and explains that only its first frame is copied", async () => {
    await stopToPreview();
    fireEvent.click(screen.getByTestId("screenshot-recorder-copy"));
    expect(await screen.findByTestId("screenshot-recorder-notice")).toHaveTextContent("screenshot.copiedFirstFrame");
    expect(mocks.copyImage).toHaveBeenCalledWith(gif.path);
    expect(mocks.closeOverlay).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screenshot-recorder-error")).not.toBeInTheDocument();
  });

  it.each(["dialog", "save", "copy"])("shows %s errors and permits recovery", async (operation) => {
    await stopToPreview();
    if (operation === "dialog") mocks.saveDialog.mockRejectedValueOnce(new Error("dialog failed"));
    else if (operation === "save") {
      mocks.saveDialog.mockResolvedValue("D:/unit-fixture/saved.gif");
      mocks.saveFile.mockRejectedValueOnce(new Error("disk full"));
    } else mocks.copyImage.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const button = screen.getByTestId(operation === "copy" ? "screenshot-recorder-copy" : "screenshot-recorder-save");
    fireEvent.click(button);
    const error = await screen.findByTestId("screenshot-recorder-error");
    expect(error).toHaveTextContent(operation === "copy" ? "screenshot.copyFailed" : "screenshot.saveFailed");
    expect(error).toHaveTextContent(operation === "dialog" ? "dialog failed" : operation === "save" ? "disk full" : "clipboard unavailable");
    expect(mocks.closeOverlay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-recorder-copy"));
    await screen.findByTestId("screenshot-recorder-notice");
    expect(screen.queryByTestId("screenshot-recorder-error")).not.toBeInTheDocument();
  });

  it("does not save when a delayed dialog completes after Done", async () => {
    const destination = deferred<string | null>();
    mocks.saveDialog.mockReturnValue(destination.promise);
    await stopToPreview();
    fireEvent.click(screen.getByTestId("screenshot-recorder-save"));
    await waitFor(() => expect(mocks.saveDialog).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("screenshot-recorder-done"));
    await act(async () => destination.resolve("D:/unit-fixture/saved.gif"));
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.closeOverlay).toHaveBeenCalledTimes(1);
  });
});

describe("RecorderBar backend auto-end listener", () => {
  it.each([null, "capture source failed"])("shows %j notice while finishing and finalizes only the matching recording", async (error) => {
    const stop = deferred<RecordingFile>();
    mocks.stopRecording.mockReturnValue(stop.promise);
    await renderReady();
    emitEnded("another-recording", error);
    expect(mocks.stopRecording).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screenshot-recorder-notice")).not.toBeInTheDocument();
    emitEnded("recording-1", error);
    expect(screen.getByTestId("screenshot-recorder-notice")).toHaveTextContent(error ?? "screenshot.recordLimitReached");
    expect(screen.getByText("screenshot.recordFinishing")).toBeInTheDocument();
    expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 140 }));
    emitEnded("recording-1", "duplicate event");
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("screenshot-recorder-notice")).not.toHaveTextContent("duplicate event");
    await act(async () => stop.resolve(gif));
    await screen.findByTestId("screenshot-recorder-preview");
    expect(screen.getByTestId("screenshot-recorder-notice")).toHaveTextContent(error ?? "screenshot.recordLimitReached");
  });

  it("unregisters a listener that resolves after unmount and ignores its callback", async () => {
    const subscription = deferred<() => void>();
    mocks.listen.mockReturnValue(subscription.promise);
    const { unmount } = await renderReady();
    unmount();
    emitEnded();
    expect(mocks.stopRecording).not.toHaveBeenCalled();
    await act(async () => subscription.resolve(mocks.unlisten));
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps manual Stop available when listener registration fails", async () => {
    mocks.listen.mockRejectedValue(new Error("event bridge unavailable"));
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    await screen.findByTestId("screenshot-recorder-preview");
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
  });
});

describe("RecorderBar preview ownership and stale work", () => {
  it("revokes the owned blob and unregisters events on unmount", async () => {
    await stopToPreview();
    cleanup();
    expect(mocks.revokeScreenshotUrl.mock.calls.filter(([url]) => url === "blob:unit-preview")).toHaveLength(1);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "done"])("revokes a late preview blob after %s without fetching its size", async (end) => {
    const url = deferred<string>();
    mocks.loadScreenshotUrl.mockReturnValue(url.promise);
    const { unmount } = await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    await waitFor(() => expect(mocks.loadScreenshotUrl).toHaveBeenCalledWith(gif.path));
    if (end === "unmount") unmount();
    else fireEvent.click(screen.getByTestId("screenshot-recorder-done"));
    await act(async () => url.resolve("blob:late-preview"));
    expect(mocks.revokeScreenshotUrl).toHaveBeenCalledWith("blob:late-preview");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screenshot-recorder-preview")).not.toBeInTheDocument();
  });

  it("does not start a preview load if resize finishes after unmount", async () => {
    const resize = deferred<void>();
    mocks.setSize.mockReturnValue(resize.promise);
    const { unmount } = await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    await waitFor(() => expect(mocks.setSize).toHaveBeenCalled());
    unmount();
    await act(async () => resize.resolve());
    expect(mocks.loadScreenshotUrl).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("ignores a late blob-size %s after Done and revokes only once", async (completion) => {
    const bytes = deferred<Blob>();
    mocks.fetch.mockResolvedValue({ blob: () => bytes.promise });
    await stopToPreview();
    fireEvent.click(screen.getByTestId("screenshot-recorder-done"));
    await act(async () => {
      if (completion === "resolve") bytes.resolve(new Blob([new Uint8Array(8192)]));
      else bytes.reject(new Error("revoked URL"));
    });
    expect(screen.getByTestId("screenshot-recorder-meta")).not.toHaveTextContent("8 KB");
    expect(screen.queryByTestId("screenshot-recorder-error")).not.toBeInTheDocument();
    cleanup();
    expect(mocks.revokeScreenshotUrl.mock.calls.filter(([url]) => url === "blob:unit-preview")).toHaveLength(1);
  });

  it("shows preview loading failure without allowing another Stop", async () => {
    mocks.loadScreenshotUrl.mockRejectedValue(new Error("artifact unavailable"));
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    expect(await screen.findByTestId("screenshot-recorder-error")).toHaveTextContent("artifact unavailable");
    expect(screen.queryByTestId("screenshot-recorder-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("screenshot-recorder-stop")).not.toBeInTheDocument();
    expect(screen.getByTestId("screenshot-recorder-done")).toBeEnabled();
    fireEvent.click(screen.getByTestId("screenshot-recorder-done"));
    await waitFor(() => expect(mocks.closeOverlay).toHaveBeenCalledTimes(1));
  });

  it("ignores a preview error arriving after Done", async () => {
    const url = deferred<string>();
    mocks.loadScreenshotUrl.mockReturnValue(url.promise);
    await renderReady();
    fireEvent.click(screen.getByTestId("screenshot-recorder-stop"));
    await waitFor(() => expect(mocks.loadScreenshotUrl).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("screenshot-recorder-done"));
    await act(async () => url.reject(new Error("stale artifact error")));
    expect(screen.queryByTestId("screenshot-recorder-error")).not.toBeInTheDocument();
  });
});

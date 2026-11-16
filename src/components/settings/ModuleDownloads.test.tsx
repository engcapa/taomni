import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { useModuleDownloadStore } from "../../stores/moduleDownloadStore";
import { ModuleDownloads } from "./ModuleDownloads";

const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn(), resume: vi.fn(), forget: vi.fn() }));
vi.mock("../../lib/ipc/plugin", () => ({ listPluginDownloads: mocks.list, cancelPluginDownload: mocks.cancel, resumePluginDownload: mocks.resume, forgetPluginDownload: mocks.forget }));
const task = { id: "hello", completedPath: "/modules/hello.pkg", progress: { revision: 3, phase: "downloading" as const, downloaded: 4096, total: 8192 } };

describe("ModuleDownloads", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ tasks: [task], recoveryErrors: [] });
    useModuleDownloadStore.setState({ tasks: [], recoveryErrors: [], error: null, errors: {}, busy: {}, loaded: false });
  });
  afterEach(cleanup);

  it("shows bytes and percentage, keeps the native task when closed and discovers its cancelled state on reopening", async () => {
    const view = render(<ModuleDownloads />);
    await waitFor(() => expect(screen.getByTestId("module-download-task")).toHaveAttribute("data-phase", "downloading"));
    expect(screen.getByTestId("module-download-bytes")).toHaveTextContent("4.0 KiB / 8.0 KiB · 50.0%");
    expect(screen.getByTestId("module-download-progress")).toHaveAttribute("value", "50");
    view.unmount();
    expect(mocks.cancel).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue({ tasks: [{ ...task, progress: { ...task.progress, phase: "cancelled" } }], recoveryErrors: [] });
    render(<ModuleDownloads />);
    await waitFor(() => expect(screen.getByTestId("module-download-resume")).toBeVisible());
    expect(screen.getByTestId("module-download-task")).toHaveAttribute("data-downloaded", "4096");
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("uses an indeterminate indicator and offers recovery without faking native success", async () => {
    mocks.list.mockResolvedValue({ tasks: [{ ...task, progress: { ...task.progress, total: null } }], recoveryErrors: ["damaged task"] });
    mocks.cancel.mockResolvedValue({ ...task.progress, phase: "cancelled", total: null });
    mocks.resume.mockRejectedValueOnce(new Error("proxy connection refused"));
    render(<ModuleDownloads />);
    await waitFor(() => expect(screen.getByTestId("module-download-progress")).toBeVisible());
    expect(screen.getByTestId("module-download-progress")).not.toHaveAttribute("value");
    expect(screen.getByTestId("module-download-recovery-error")).toHaveTextContent("damaged task");
    fireEvent.click(screen.getByTestId("module-download-cancel"));
    await waitFor(() => expect(screen.getByTestId("module-download-resume")).toBeVisible());
    fireEvent.click(screen.getByTestId("module-download-resume"));
    await waitFor(() => expect(screen.getByTestId("module-download-error")).toHaveTextContent("proxy connection refused"));
    expect(screen.getByTestId("module-download-task")).toHaveAttribute("data-phase", "cancelled");
    mocks.forget.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("module-download-forget"));
    await waitFor(() => expect(screen.getByTestId("module-downloads-empty")).toBeVisible());
    expect(mocks.forget).toHaveBeenCalledExactlyOnceWith("hello");
  });
});

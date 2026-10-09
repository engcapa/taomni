import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollCaptureBar } from "./ScrollCaptureBar";

const api = vi.hoisted(() => ({ status: vi.fn(), stop: vi.fn(), mode: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("../../lib/screenshot", () => ({ SCROLL_PROGRESS_EVENT: "screenshot://scroll-progress", scrollStatus: api.status, stopScrollCapture: api.stop, setScrollMode: api.mode }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string, params?: { count: number }) => params ? `${key}:${params.count}` : key }));

beforeEach(() => {
  vi.resetAllMocks();
  api.status.mockResolvedValue({ frames: 2 });
  api.stop.mockResolvedValue(undefined);
  api.mode.mockResolvedValue(undefined);
  api.listen.mockResolvedValue(api.unlisten);
});
afterEach(cleanup);

describe("scroll capture controls", () => {
  it("finishes once with Escape and retains the collected image", async () => {
    render(<ScrollCaptureBar />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(false);
    await waitFor(() => expect(screen.getByTestId("screenshot-scroll-stop")).toBeDisabled());
  });
  it("allows manual takeover and retains the current mode if switching fails", async () => {
    api.status.mockResolvedValue({ frames: 3, mode: "manual", needsOverlap: false });
    render(<ScrollCaptureBar />);
    await waitFor(() => expect(screen.getByTestId("screenshot-scroll-mode-hint")).toHaveTextContent("screenshot.scrollManualHint"));
    api.mode.mockRejectedValueOnce(new Error("permission denied"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-switch-mode"));
    await screen.findByTestId("screenshot-scroll-error");
    expect(screen.getByTestId("screenshot-scroll-switch-mode")).toHaveTextContent("screenshot.scrollUseAuto");
    fireEvent.click(screen.getByTestId("screenshot-scroll-switch-mode"));
    await waitFor(() => expect(screen.getByTestId("screenshot-scroll-switch-mode")).toHaveTextContent("screenshot.scrollUseManual"));
    expect(api.mode).toHaveBeenLastCalledWith("auto");
  });
  it("shows live progress and requests a single finish that keeps the captured content", async () => {
    const view = render(<ScrollCaptureBar />);
    await waitFor(() => expect(screen.getByTestId("screenshot-scroll-progress")).toHaveTextContent(":2"));
    act(() => api.listen.mock.calls[0][1]({ payload: { frames: 5 } }));
    expect(screen.getByTestId("screenshot-scroll-progress")).toHaveTextContent(":5");
    fireEvent.click(screen.getByTestId("screenshot-scroll-stop"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-stop"));
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.getByTestId("screenshot-scroll-cancel")).toBeDisabled();
    view.unmount();
    expect(api.unlisten).toHaveBeenCalledOnce();
  });

  it("cancels explicitly and allows retry when cancellation fails", async () => {
    api.stop.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<ScrollCaptureBar />);
    fireEvent.click(screen.getByTestId("screenshot-scroll-cancel"));
    await screen.findByTestId("screenshot-scroll-error");
    expect(screen.getByTestId("screenshot-scroll-cancel")).toBeEnabled();
    fireEvent.click(screen.getByTestId("screenshot-scroll-cancel"));
    expect(api.stop).toHaveBeenLastCalledWith(true);
    expect(api.stop).toHaveBeenCalledTimes(2);
  });
});

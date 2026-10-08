import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createScreenshotFavoritesFault } from "../../stubs/screenshotFavoritesFault";
import { ScreenshotFavorites } from "./ScreenshotFavorites";
const api = vi.hoisted(() => ({ list: vi.fn(), thumbnail: vi.fn(), pin: vi.fn(), remove: vi.fn(), revoke: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/screenshot", () => ({ listScreenshotFavorites: api.list, loadFavoriteThumbnail: api.thumbnail, pinScreenshotFavorite: api.pin, removeScreenshotFavorite: api.remove, revokeScreenshotUrl: api.revoke }));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/appDialogs", () => ({ formatUnknownError: (e: unknown) => String(e), useAppDialogs: () => ({ confirm: api.confirm }) }));
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([{ id: "saved-1", width: 800, height: 600, createdAt: 1 }]);
  api.thumbnail.mockResolvedValue("blob:favorite");
  api.pin.mockResolvedValue("screenshot-pin-2");
  api.remove.mockResolvedValue(undefined);
  api.confirm.mockResolvedValue(true);
});
afterEach(cleanup);
describe("ScreenshotFavorites", () => {
  it("shows the stored note on each item with a full tooltip and hides the block without one", async () => {
    api.list.mockResolvedValue([
      { id: "with-note", width: 800, height: 600, createdAt: 2, note: "登录页对照" },
      { id: "no-note", width: 400, height: 300, createdAt: 1, note: "" },
    ]);
    render(<ScreenshotFavorites onClose={vi.fn()} />);
    const items = await screen.findAllByTestId("screenshot-favorite-item");
    expect(items).toHaveLength(2);
    const note = screen.getByTestId("screenshot-favorite-note");
    expect(note).toHaveTextContent("登录页对照");
    expect(note).toHaveAttribute("title", "登录页对照");
    // Empty notes render no placeholder block at all.
    expect(screen.getAllByTestId("screenshot-favorite-note")).toHaveLength(1);
  });

  it("reopens a saved original and removes only after confirmation, with thumbnail cleanup", async () => {
    const view = render(<ScreenshotFavorites onClose={vi.fn()} />);
    await screen.findByTestId("screenshot-favorite-thumbnail");
    fireEvent.click(screen.getByTestId("screenshot-favorite-open"));
    await waitFor(() => expect(api.pin).toHaveBeenCalledWith("saved-1"));
    await waitFor(() => expect(screen.getByTestId("screenshot-favorite-remove")).toBeEnabled());
    api.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("screenshot-favorite-remove"));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-favorite-remove"));
    await screen.findByTestId("screenshot-favorites-empty");
    expect(api.remove).toHaveBeenCalledWith("saved-1");
    expect(api.revoke).toHaveBeenCalledWith("blob:favorite");
    view.unmount();
  });
  it("shows load errors and recovers through refresh", async () => {
    api.list.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<ScreenshotFavorites onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
    fireEvent.click(screen.getByTestId("screenshot-favorites-refresh"));
    await screen.findByTestId("screenshot-favorite-thumbnail");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("retains a failed initial load through StrictMode replay and recovers on refresh", async () => {
    const fails = createScreenshotFavoritesFault();
    api.list.mockImplementation(() => fails("once")
      ? Promise.reject(new Error("storage unavailable")) : Promise.resolve([]));
    render(<StrictMode><ScreenshotFavorites onClose={vi.fn()} /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
    expect(api.list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("screenshot-favorites-refresh"));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByTestId("screenshot-favorites-empty")).toBeVisible();
    expect(api.list).toHaveBeenCalledTimes(3);
  });
});

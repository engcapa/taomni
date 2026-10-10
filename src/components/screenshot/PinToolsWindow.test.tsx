import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinToolsWindow } from "./PinToolsWindow";

const api = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn(), close: vi.fn(), listPins: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: api.close }) }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: api.emitTo, listen: vi.fn(async (event, fn) => { api.listeners.set(event, fn); return () => api.listeners.delete(event); }) }));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/screenshot", async (original) => ({ ...await original<typeof import("../../lib/screenshot")>(), listPins: api.listPins }));

beforeEach(() => {
  vi.clearAllMocks(); api.listeners.clear();
  api.invoke.mockResolvedValue({ label: "screenshot-pin-9", view: { zoom: 1, opacity: 1, note: "Original", busy: false, error: null, notice: null } });
  api.emitTo.mockResolvedValue(undefined); api.close.mockResolvedValue(undefined);
  api.listPins.mockResolvedValue([{ label: "screenshot-pin-9", note: "Original", width: 160, height: 120, order: 9 }]);
});
afterEach(cleanup);

describe("separate pin options", () => {
  it("waits for the source pin before exposing editable controls", async () => {
    let initialize!: (value: unknown) => void;
    api.invoke.mockReturnValueOnce(new Promise((resolve) => { initialize = resolve; }));
    render(<PinToolsWindow />);
    expect(screen.queryByTestId("screenshot-pin-note-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("screenshot-pin-tools-close")).toBeEnabled();
    await waitFor(() => expect(api.invoke).toHaveBeenCalled());
    await act(async () => initialize({ label: "screenshot-pin-9", view: { zoom: 1, opacity: 1, note: "Original", busy: false, error: null, notice: null } }));
    expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Original");
    fireEvent.change(screen.getByTestId("screenshot-pin-note-input"), { target: { value: "New note" } });
    fireEvent.click(screen.getByTestId("screenshot-pin-note-save"));
    expect(api.emitTo).toHaveBeenCalledWith("screenshot-pin-9", "screenshot://pin-tool", { action: "note", value: "New note" });
  });

  it("keeps consecutive opacity changes through delayed source replies", async () => {
    render(<PinToolsWindow />);
    const slider = await screen.findByTestId("screenshot-pin-opacity");
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Original"));
    fireEvent.change(slider, { target: { value: "20" } });
    expect(slider).toHaveValue("20");
    fireEvent.change(slider, { target: { value: "50" } });
    const source = { zoom: 1, note: "Original", busy: false, error: null, notice: null };
    act(() => api.listeners.get("screenshot://pin-view")?.({ payload: { ...source, opacity: 0.2 } }));
    expect(slider).toHaveValue("50");
    act(() => api.listeners.get("screenshot://pin-view")?.({ payload: { ...source, opacity: 0.5 } }));
    expect(slider).toHaveValue("50");
    act(() => api.listeners.get("screenshot://pin-view")?.({ payload: { ...source, opacity: 1 } }));
    expect(slider).toHaveValue("100");
  });

  it("restores confirmed opacity if the source window cannot receive a change", async () => {
    render(<PinToolsWindow />);
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Original"));
    api.emitTo.mockRejectedValueOnce(new Error("source closed"));
    fireEvent.change(screen.getByTestId("screenshot-pin-opacity"), { target: { value: "50" } });
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-opacity")).toHaveValue("100"));
    expect(screen.getByRole("alert")).toHaveTextContent("source closed");
  });

  it("keeps per-pin and all-pin actions in accessible tabs and targets the original window", async () => {
    render(<PinToolsWindow />);
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Original"));
    expect(screen.getByTestId("screenshot-pin-tab-pin")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("screenshot-pin-zoom-in"));
    expect(api.emitTo).toHaveBeenCalledWith("screenshot-pin-9", "screenshot://pin-tool", { action: "zoom", value: 1.1 });
    fireEvent.click(screen.getByTestId("screenshot-pin-tab-all"));
    expect(screen.getByTestId("screenshot-pins-tile")).toBeVisible();
    expect(screen.queryByTestId("screenshot-pin-help")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-pins-tile"));
    expect(api.emitTo).toHaveBeenCalledWith("screenshot-pin-9", "screenshot://pin-tool", { action: "arrange", value: "tile" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.close).toHaveBeenCalledOnce();
  });

  it("retains an unsaved note through unrelated view updates and shows parent errors", async () => {
    const view = render(<PinToolsWindow />);
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Original"));
    fireEvent.change(screen.getByTestId("screenshot-pin-note-input"), { target: { value: "Draft" } });
    act(() => api.listeners.get("screenshot://pin-view")?.({ payload: { zoom: 1.5, opacity: 0.5, note: "Original", busy: false, error: "disk full", notice: null } }));
    expect(screen.getByTestId("screenshot-pin-note-input")).toHaveValue("Draft");
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    fireEvent.click(screen.getByTestId("screenshot-pin-note-save"));
    expect(api.emitTo).toHaveBeenCalledWith("screenshot-pin-9", "screenshot://pin-tool", { action: "note", value: "Draft" });
    view.unmount(); expect(api.listeners.size).toBe(0);
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingNotesPanel } from "./FloatingNotesPanel";
import { NotesPanel } from "./NotesPanel";
import { DEFAULT_NOTES_PANEL_POSITION, useNotesStore } from "../../stores/notesStore";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "notes_list":
      case "notes_list_tags":
      case "notes_list_alerts":
        return [];
      case "notes_get_prefs":
        return {};
      default:
        return undefined;
    }
  });
  useNotesStore.setState({
    notes: [],
    notesLoaded: true,
    prefsLoaded: true,
    activeNoteId: null,
    filter: "recent_incomplete",
    statusFilters: ["recent_incomplete"],
    search: "",
    tagFilterId: null,
    tags: [],
    alerts: [],
    panelMode: "hub",
    theme: "taomni",
    font: "inherit",
    fontSize: 12,
    alwaysOnTopInApp: false,
    panelPosition: DEFAULT_NOTES_PANEL_POSITION,
  });
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("FloatingNotesPanel", () => {
  it("is hidden in hub mode", () => {
    render(<FloatingNotesPanel />);
    expect(screen.queryByTestId("floating-notes-panel")).not.toBeInTheDocument();
  });

  it("renders a single floating panel in floating mode", async () => {
    useNotesStore.setState({ panelMode: "floating" });
    render(<FloatingNotesPanel />);
    expect(await screen.findByTestId("floating-notes-panel")).toBeInTheDocument();
    // Exactly one notes panel exists (no duplicate hub instance).
    expect(screen.getAllByTestId("floating-notes-panel")).toHaveLength(1);
  });

  it("adds a floating panel without removing the hub notes panel", async () => {
    useNotesStore.setState({ panelMode: "floating" });
    render(
      <>
        <NotesPanel />
        <FloatingNotesPanel />
      </>,
    );

    expect(await screen.findByTestId("floating-notes-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("notes-panel")).toHaveLength(2);
  });

  it("docks back to the hub, hiding the floating panel", async () => {
    useNotesStore.setState({ panelMode: "floating" });
    render(<FloatingNotesPanel />);
    await screen.findByTestId("floating-notes-dock");
    fireEvent.click(screen.getByTestId("floating-notes-dock"));
    expect(useNotesStore.getState().panelMode).toBe("hub");
    await waitFor(() => expect(screen.queryByTestId("floating-notes-panel")).not.toBeInTheDocument());
  });

  it("raises z-index when always-on-top is enabled", async () => {
    useNotesStore.setState({ panelMode: "floating", alwaysOnTopInApp: true });
    render(<FloatingNotesPanel />);
    const panel = await screen.findByTestId("floating-notes-panel");
    // Stays below modal dialogs (z-50) but above normal content.
    expect(panel.className).toContain("z-40");
    expect(panel).toHaveAttribute("data-always-on-top", "true");
  });

  it("docks the main window when a detached notes window signals dock", () => {
    useNotesStore.setState({ panelMode: "floating" });
    render(<FloatingNotesPanel />);

    window.dispatchEvent(new StorageEvent("storage", { key: "taomni.notes.dockSignal.v1" }));

    expect(useNotesStore.getState().panelMode).toBe("hub");
  });

  it("opens an OS notes window instead of rendering the in-app panel in Tauri", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    useNotesStore.setState({ panelMode: "floating" });
    render(<FloatingNotesPanel />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_detached_window", {
        kind: "notes",
        sessionId: "panel",
        title: "Notes",
        width: DEFAULT_NOTES_PANEL_POSITION.width,
        height: DEFAULT_NOTES_PANEL_POSITION.height,
      }),
    );
    expect(screen.queryByTestId("floating-notes-panel")).not.toBeInTheDocument();
  });
});

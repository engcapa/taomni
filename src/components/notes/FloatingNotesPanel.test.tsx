import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingNotesPanel } from "./FloatingNotesPanel";
import { useNotesStore } from "../../stores/notesStore";

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
    search: "",
    tagFilterId: null,
    tags: [],
    alerts: [],
    panelMode: "hub",
    theme: "taomni",
    alwaysOnTopInApp: false,
    panelPosition: { x: 100, y: 100, width: 460, height: 560 },
  });
});

afterEach(() => cleanup());

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
});

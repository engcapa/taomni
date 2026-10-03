import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNotesStore } from "../../stores/notesStore";
import { useChatStore } from "../../stores/chatStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import type { NoteItem } from "../../lib/notes";
import { ShellNotesSurface } from "./ShellNotesSurface";
import { ShellSurfaceRegistry, SurfaceSlot } from "./SurfaceSlot";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const note: NoteItem = { id: "surface-note", title: "saved", body: "body", pinned: false, color: null, priority: 0,
  completed_at: null, archived_at: null, due_at: null, reminder_at: null, repeat_rule: null,
  source_tab_id: null, source_session_id: null, source_title: null, source_uri: null, created_at: 1, updated_at: 1, steps: [], tags: [] };
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => command === "notes_list" ? [note] : command === "notes_get_prefs" ? {} : []);
  useNotesStore.setState({ notes: [note], activeNoteId: note.id, activeNoteSnapshot: note, notesLoaded: true, prefsLoaded: true, panelMode: "hub" });
  useChatStore.setState({ drawerOpen: true });
  useTaoHubStore.setState({ hubTab: "notes" });
});
afterEach(cleanup);

it("keeps the actual editor, unsaved text and selection across Hub switches and float/dock", async () => {
  render(<ShellSurfaceRegistry><SurfaceSlot id="notes:hub" /><SurfaceSlot id="notes:floating" /><ShellNotesSurface /></ShellSurfaceRegistry>);
  const input = await screen.findByTestId("note-editor-title") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "uncommitted 中文" } });
  input.setSelectionRange(3, 7);
  act(() => useTaoHubStore.setState({ hubTab: "notifications" }));
  expect(input.closest('[data-surface-id="notes"]')).toHaveAttribute("aria-hidden", "true");
  act(() => { useNotesStore.setState({ panelMode: "floating" }); useTaoHubStore.setState({ hubTab: "chat" }); });
  expect(screen.getByTestId("note-editor-title")).toBe(input);
  expect(input.closest('[data-slot-id="notes:floating"]')).toBeInTheDocument();
  expect(input).toHaveValue("uncommitted 中文");
  expect(input.selectionStart).toBe(3);
  act(() => { useNotesStore.setState({ panelMode: "hub" }); useTaoHubStore.setState({ hubTab: "notes" }); });
  await waitFor(() => expect(input.closest('[data-slot-id="notes:hub"]')).toBeInTheDocument());
  expect(screen.getAllByTestId("note-editor")).toHaveLength(1);
  expect(input).toHaveValue("uncommitted 中文");
});

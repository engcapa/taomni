import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useNotesWorkspaceCommands } from "./useNotesWorkspaceCommands";
import type { NoteItem } from "../../lib/notes";
import type { WorkspaceCommandRegistration } from "../editor/workspace/workspaceCommands";

const ipc = vi.hoisted(() => ({ saveNoteContent: vi.fn() }));
vi.mock("../../lib/notes", () => ({ ...ipc, getNote: vi.fn(), listNotes: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  useNotesContentStore.setState({ documents: {} });
  vi.clearAllMocks();
});

it("publishes live menu availability and saves only through the current note owner", async () => {
  const note = { id: "note-a", title: "Menu note", body: "original" } as NoteItem;
  useNotesContentStore.getState().adopt(note);
  let current: WorkspaceCommandRegistration | null = null;
  const change = vi.fn((_id: string, next: WorkspaceCommandRegistration | null) => { current = next; });
  const { unmount } = renderHook(() => useNotesWorkspaceCommands(note.id, "note-tab", "notes-workspace", change));
  await waitFor(() => expect(current?.items.find((item) => item.id === "notes.save")?.enabled).toBe(false));
  act(() => useNotesContentStore.getState().edit(note, { body: "changed" }));
  await waitFor(() => expect(current?.items.find((item) => item.id === "notes.save")?.enabled).toBe(true));
  ipc.saveNoteContent.mockResolvedValue({ ...note, body: "changed" });
  await act(async () => { expect((await current!.executeAction("notes.save")).kind).toBe("applied"); });
  expect(ipc.saveNoteContent).toHaveBeenCalledTimes(1);
  expect(ipc.saveNoteContent).toHaveBeenCalledWith(note.id, { title: note.title, body: "changed" }, { title: note.title, body: "original" });
  await waitFor(() => expect(current?.items.find((item) => item.id === "notes.save")?.enabled).toBe(false));
  unmount();
  expect(change).toHaveBeenLastCalledWith("note-tab", null);
});

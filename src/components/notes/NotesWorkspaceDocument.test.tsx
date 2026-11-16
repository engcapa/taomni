import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { NotesWorkspaceDocument } from "./NotesWorkspaceDocument";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useDocumentStore } from "../../stores/documentStore";
import type { NoteItem } from "../../lib/notes";
import type { WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { noteWorkspaceModes } from "../../lib/notes/notesWorkspaceNavigation";

const ipc = vi.hoisted(() => ({ getNote: vi.fn(), listNotes: vi.fn(), saveNoteContent: vi.fn() }));
vi.mock("../../lib/notes", async (original) => ({ ...await original<typeof import("../../lib/notes")>(), ...ipc }));
vi.mock("./useNoteTask", () => ({ useNoteTask: () => null }));
vi.mock("../viewer/markdown/markdownExport", () => ({ exportMarkdown: vi.fn() }));
const note = { id: "shared-note", title: "Shared", body: "# Markdown\n\n**same renderer**\n", priority: 2, tags: ["keep"], steps: [] } as unknown as NoteItem;
const tab = { id: "ws:notes-workspace:note:shared-note", workspaceId: "notes-workspace", noteId: note.id } as WorkspaceIsolatedTab;

beforeEach(() => {
  localStorage.clear(); noteWorkspaceModes.clear(); vi.clearAllMocks();
  useNotesContentStore.setState({ documents: {} }); useDocumentStore.setState({ documents: {} });
  useNotesContentStore.getState().adopt(note);
  ipc.getNote.mockResolvedValue(note);
  ipc.saveNoteContent.mockImplementation(async (_id, content) => ({ ...note, ...content }));
});
afterEach(() => { cleanup(); noteWorkspaceModes.clear(); });

it("uses the shared Markdown UI but edits/saves the same Note, with browse gating and retained Undo", async () => {
  render(<NotesWorkspaceDocument tab={tab} visible />);
  await waitFor(() => expect(screen.getByTestId("markdown-editor")).toHaveAttribute("data-mode", "live"));
  const dom = screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(dom)!;
  expect(view.state.readOnly).toBe(true);
  expect(dom).toHaveTextContent("same renderer");
  fireEvent.click(screen.getByTestId("markdown-live-edit"));
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "workspace edit\n" } }));
  expect(useNotesContentStore.getState().documents[note.id].body).toContain("workspace edit");
  expect(useDocumentStore.getState().documents).toEqual({});
  fireEvent.click(screen.getByTestId("markdown-mode-split"));
  expect(EditorView.findFromDOM(dom)).toBe(view);
  expect(screen.getByTestId("markdown-split-resize")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("notes-workspace-save"));
  await waitFor(() => expect(ipc.saveNoteContent).toHaveBeenCalledTimes(1));
  expect(ipc.saveNoteContent).toHaveBeenCalledWith(note.id, { title: "Shared", body: view.state.doc.toString() }, { title: "Shared", body: note.body });
  act(() => { expect(undo(view)).toBe(true); });
  expect(useNotesContentStore.getState().documents[note.id].body).toBe(note.body);
  expect(useDocumentStore.getState().documents).toEqual({});
});

it("adopts compact-editor changes and title changes without replacing the Note identity or disk-saving", async () => {
  render(<NotesWorkspaceDocument tab={tab} visible />);
  const dom = screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(dom)!;
  act(() => useNotesContentStore.getState().edit(note, { body: "# Compact edit", title: "Renamed" }));
  expect(view.state.doc.toString()).toBe("# Compact edit");
  expect(screen.getByTestId("notes-workspace-title")).toHaveValue("Renamed");
  expect(screen.getByTestId("notes-workspace-document")).toHaveAttribute("data-note-id", note.id);
  expect(view.state.readOnly).toBe(true);
  expect(useDocumentStore.getState().documents).toEqual({});
});

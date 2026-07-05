import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import { useNotesStore } from "../../stores/notesStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

interface FakeNote {
  id: string;
  title: string;
  body: string;
  completed_at: number | null;
  pinned: boolean;
  archived_at: number | null;
  color: string | null;
  priority: number;
  due_at: number | null;
  reminder_at: number | null;
  repeat_rule: string | null;
  source_tab_id: string | null;
  source_session_id: string | null;
  source_title: string | null;
  source_uri: string | null;
  created_at: number;
  updated_at: number;
  steps: unknown[];
  tags: unknown[];
}

let store: FakeNote[] = [];
let seq = 0;

function blank(title: string): FakeNote {
  const ts = 1000 + seq++;
  return {
    id: `n${seq}`,
    title,
    body: "",
    completed_at: null,
    pinned: false,
    archived_at: null,
    color: null,
    priority: 0,
    due_at: null,
    reminder_at: null,
    repeat_rule: null,
    source_tab_id: null,
    source_session_id: null,
    source_title: null,
    source_uri: null,
    created_at: ts,
    updated_at: ts,
    steps: [],
    tags: [],
  };
}

function filterNotes(q: Record<string, unknown>): FakeNote[] {
  const filter = (q.filter as string) ?? "recent_incomplete";
  const filters = Array.isArray(q.filters) && q.filters.length > 0 ? q.filters.map(String) : [filter];
  const search = ((q.search as string) ?? "").toLowerCase();
  let list = store.filter((n) =>
    filters.some((status) => {
      switch (status) {
        case "all":
          return n.archived_at === null;
        case "completed":
          return n.archived_at === null && n.completed_at !== null;
        default:
          return n.archived_at === null && n.completed_at === null;
      }
    }),
  );
  if (search) list = list.filter((n) => n.title.toLowerCase().includes(search) || n.body.toLowerCase().includes(search));
  return list;
}

beforeEach(() => {
  store = [];
  seq = 0;
  useNotesStore.setState({
    notes: [],
    notesLoaded: false,
    prefsLoaded: false,
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
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "notes_list":
        return filterNotes((args.query as Record<string, unknown>) ?? {});
      case "notes_get_prefs":
        return {};
      case "notes_list_tags":
        return [];
      case "notes_list_alerts":
        return [];
      case "notes_create": {
        const note = blank(((args.input as Record<string, unknown>)?.title as string) ?? "");
        store.unshift(note);
        return note;
      }
      case "notes_toggle_complete": {
        const note = store.find((n) => n.id === args.id);
        if (note) note.completed_at = args.completed ? 1234 : null;
        return note ?? null;
      }
      case "notes_update": {
        const note = store.find((n) => n.id === args.id);
        const patch = (args.patch as Record<string, unknown>) ?? {};
        if (note) {
          note.title = (patch.title as string) ?? note.title;
          note.body = (patch.body as string) ?? "";
        }
        return note ?? null;
      }
      default:
        return undefined;
    }
  });
});

afterEach(() => cleanup());

describe("NotesPanel", () => {
  it("shows the empty state before any notes exist", async () => {
    render(<NotesPanel />);
    expect(await screen.findByText("No notes yet")).toBeInTheDocument();
  });

  it("keeps the status filter in the top toolbar", async () => {
    render(<NotesPanel />);
    await screen.findByTestId("notes-new");

    const toolbar = screen.getByTestId("notes-toolbar");
    expect(toolbar).toContainElement(screen.getByTestId("notes-new"));
    expect(toolbar).toContainElement(screen.getByTestId("notes-filter-menu"));
    expect(toolbar).toContainElement(screen.getByTestId("notes-search"));
    expect(toolbar).toContainElement(screen.getByTestId("notes-floating-toggle"));
    expect(toolbar).toContainElement(screen.getByTestId("notes-settings-toggle"));
  });

  it("toggles the additive floating panel from the top toolbar", async () => {
    render(<NotesPanel />);
    await screen.findByTestId("notes-floating-toggle");

    fireEvent.click(screen.getByTestId("notes-floating-toggle"));
    expect(useNotesStore.getState().panelMode).toBe("floating");
    expect(screen.getByTestId("notes-floating-toggle")).toHaveTextContent("In hub");

    fireEvent.click(screen.getByTestId("notes-floating-toggle"));
    expect(useNotesStore.getState().panelMode).toBe("hub");
    expect(screen.getByTestId("notes-floating-toggle")).toHaveTextContent("Floating");
  });

  it("keeps floating controls out of the settings panel", async () => {
    render(<NotesPanel />);
    await screen.findByTestId("notes-settings-toggle");

    fireEvent.click(screen.getByTestId("notes-settings-toggle"));

    expect(await screen.findByTestId("note-theme-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("note-panel-mode-floating")).not.toBeInTheDocument();
    expect(screen.queryByTestId("note-panel-mode-hub")).not.toBeInTheDocument();
  });

  it("creates a new note that defaults to incomplete and opens the editor", async () => {
    render(<NotesPanel />);
    await screen.findByTestId("notes-new");
    fireEvent.click(screen.getByTestId("notes-new"));
    // createNote sets the new note active → the editor mounts.
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(store).toHaveLength(1);
    expect(store[0].completed_at).toBeNull();
  });

  it("keeps completed notes out of the default recent-incomplete view", async () => {
    store.push(blank("keep me"));
    render(<NotesPanel />);
    const item = await screen.findByText("keep me");
    expect(item).toBeInTheDocument();

    // Complete it from the list checkbox.
    fireEvent.click(screen.getByTestId("notes-toggle-complete"));
    await waitFor(() => expect(screen.queryByText("keep me")).not.toBeInTheDocument());
  });

  it("switches to the Completed filter to reveal completed notes", async () => {
    const done = blank("finished");
    done.completed_at = 5;
    store.push(done);
    render(<NotesPanel />);
    // Not visible under the default recent-incomplete view.
    await waitFor(() => expect(screen.queryByText("finished")).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId("notes-filter-menu"));
    fireEvent.click(screen.getByTestId("notes-filter-completed"));
    expect(await screen.findByText("finished")).toBeInTheDocument();
  });

  it("filters the list by search text", async () => {
    store.push(blank("deployment plan"));
    store.push(blank("grocery list"));
    render(<NotesPanel />);
    await screen.findByText("deployment plan");

    fireEvent.change(screen.getByTestId("notes-search"), { target: { value: "deploy" } });
    await waitFor(() => expect(screen.queryByText("grocery list")).not.toBeInTheDocument());
    expect(screen.getByText("deployment plan")).toBeInTheDocument();
  });

  it("opens a note in the editor and edits its title", async () => {
    store.push(blank("original"));
    render(<NotesPanel />);
    fireEvent.click(await screen.findByText("original"));

    const titleInput = (await screen.findByTestId("note-editor-title")) as HTMLInputElement;
    expect(titleInput.value).toBe("original");
    fireEvent.change(titleInput, { target: { value: "renamed" } });
    fireEvent.blur(titleInput);
    await waitFor(() => expect(store[0].title).toBe("renamed"));
  });

  it("opens a body URL in the browser on ctrl click", async () => {
    const note = blank("link note");
    note.body = "See https://example.com/docs.";
    store.push(note);
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ opener: null } as Window);

    render(<NotesPanel />);
    expect(await screen.findByText("https://example.com/docs")).toHaveClass("notes-rendered-link");
    fireEvent.click(await screen.findByText("link note"));

    const body = (await screen.findByTestId("note-editor-body")) as HTMLTextAreaElement;
    const linkPreview = await screen.findByTestId("note-editor-body-link-preview");
    expect(linkPreview.querySelector(".notes-rendered-link")).toHaveTextContent("https://example.com/docs");
    body.focus();
    body.setSelectionRange(note.body.indexOf("example"), note.body.indexOf("example"));
    fireEvent.click(body, { ctrlKey: true });

    expect(openSpy).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });
});

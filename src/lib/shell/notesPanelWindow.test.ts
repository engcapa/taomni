import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelWindowMessage } from "../detachedSession";
import type { NotesWindowPayload } from "./notesPanelWindow";
import { useNotesStore } from "../../stores/notesStore";

const boundary = vi.hoisted(() => ({ listeners: new Set<(m: PanelWindowMessage) => void>(), payload: null as NotesWindowPayload | null,
  open: vi.fn(), flush: vi.fn(), restore: vi.fn(), sent: vi.fn(), destroyed: new Set<(e: { payload: { windowLabel: string; operationId: string } }) => void>(), view: { activeNoteId: null, draft: null } }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_event: string, fn: (e: { payload: { windowLabel: string; operationId: string } }) => void) => {
  boundary.destroyed.add(fn); return () => boundary.destroyed.delete(fn);
} }));
vi.mock("../detachWindowing", () => ({ openDetachedWindow: boundary.open }));
vi.mock("../notes/notesViewState", () => ({ flushNotesEditor: boundary.flush, snapshotNotesView: () => boundary.view,
  restoreNotesView: boundary.restore, validateNotesView: (s: unknown) => s }));
vi.mock("../detachedSession", () => ({
  subscribePanelWindow: (fn: (m: PanelWindowMessage) => void) => { boundary.listeners.add(fn); return () => boundary.listeners.delete(fn); },
  writeDetachedHandoff: (_kind: string, _id: string, payload: NotesWindowPayload) => { boundary.payload = payload; },
  consumeDetachedHandoff: () => boundary.payload, clearDetachedHandoff: () => { boundary.payload = null; },
  broadcastPanelWindow: (envelope: PanelWindowMessage["envelope"], data: unknown) => boundary.sent(envelope, data),
}));
import { detachNotesPanel, installNotesPanelWindowReceiver, returnNotesWindowBeforeExit, useNotesWindowStore } from "./notesPanelWindow";
function receive(envelope: PanelWindowMessage["envelope"], event: PanelWindowMessage["envelope"]["event"], data?: unknown, seq = 1) {
  for (const fn of [...boundary.listeners]) fn({ type: "panel-window", from: "child", seq, envelope: { ...envelope, event }, data });
}
async function until(read: () => boolean) { for (let n = 0; n < 100 && !read(); n++) await new Promise((r) => setTimeout(r, 5)); expect(read()).toBe(true); }
afterEach(() => { boundary.listeners.clear(); boundary.destroyed.clear(); boundary.open.mockReset(); boundary.flush.mockReset(); boundary.restore.mockReset(); boundary.sent.mockReset(); boundary.payload = null; document.body.innerHTML = ""; });

describe("Notes native handoff", () => {
  it.each(["preparing", "committing"])("keeps the source usable when the child is destroyed while %s", async (phase) => {
    const off = installNotesPanelWindowReceiver();
    useNotesStore.setState({ panelMode: "hub" });
    boundary.open.mockResolvedValue(undefined);
    const run = detachNotesPanel("Notes");
    const rejected = expect(run).rejects.toThrow(/cancelled|closed/);
    await until(() => !!boundary.payload);
    const envelope = boundary.payload!.envelope;
    if (phase === "committing") {
      receive(envelope, "ready");
      await until(() => boundary.sent.mock.calls.some(([e]) => e.event === "commit"));
    }
    for (const fn of boundary.destroyed) fn({ payload: { windowLabel: envelope.windowLabel, operationId: envelope.operationId } });
    await rejected;
    receive(envelope, "ready"); receive(envelope, "committed");
    expect(useNotesStore.getState().panelMode).toBe("hub");
    expect(useNotesWindowStore.getState().phase).toBe("docked");
    expect(useNotesWindowStore.getState().error).toBeTruthy();
    expect(boundary.payload).toBeNull();
    expect(boundary.restore).not.toHaveBeenCalled();
    off();
  });
  it("keeps the source on save and creation failures, then requires matching ready and commit acknowledgement", async () => {
    useNotesStore.setState({ panelMode: "hub" });
    boundary.flush.mockRejectedValueOnce(new Error("Disk denied"));
    await expect(detachNotesPanel("Notes")).rejects.toThrow("Disk denied");
    expect(useNotesStore.getState().panelMode).toBe("hub"); expect(boundary.open).not.toHaveBeenCalled();
    boundary.open.mockRejectedValueOnce(new Error("Window blocked"));
    await expect(detachNotesPanel("Notes")).rejects.toThrow("Window blocked");
    expect(boundary.payload).toBeNull(); expect(useNotesStore.getState().panelMode).toBe("hub");

    boundary.open.mockResolvedValue(undefined);
    const run = detachNotesPanel("Notes"); expect(detachNotesPanel("Notes")).toBe(run);
    await until(() => !!boundary.payload);
    const envelope = boundary.payload!.envelope;
    receive({ ...envelope, generation: envelope.generation - 1 }, "ready");
    expect(useNotesStore.getState().panelMode).toBe("hub");
    receive(envelope, "ready");
    await until(() => boundary.sent.mock.calls.some(([e]) => e.event === "commit"));
    expect(useNotesStore.getState().panelMode).toBe("hub");
    receive(envelope, "committed"); await run;
    expect(useNotesStore.getState().panelMode).toBe("floating"); expect(useNotesWindowStore.getState().phase).toBe("detached");
    expect(boundary.payload).toBeNull();

    const off = installNotesPanelWindowReceiver();
    const surface = document.createElement("div"); surface.dataset.surfaceId = "notes";
    const panel = document.createElement("div"); panel.dataset.testid = "notes-panel"; surface.appendChild(panel); document.body.appendChild(surface);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 300, height: 400 } as DOMRect);
    let accept!: () => void; boundary.restore.mockImplementationOnce(() => new Promise<void>((r) => { accept = r; }));
    receive(envelope, "request-reattach", boundary.view);
    await until(() => boundary.restore.mock.calls.length === 1);
    expect(boundary.sent.mock.calls.some(([e]) => e.event === "reattached")).toBe(false);
    accept(); await until(() => boundary.sent.mock.calls.some(([e]) => e.event === "reattached"));
    expect(useNotesStore.getState().panelMode).toBe("hub");
    await returnNotesWindowBeforeExit(); off();
  });
  it("recovers the latest received draft from a destroyed child and rejects stale window and snapshot events", async () => {
    const off = installNotesPanelWindowReceiver();
    boundary.open.mockResolvedValue(undefined);
    const run = detachNotesPanel("Notes");
    await until(() => !!boundary.payload);
    const envelope = boundary.payload!.envelope;
    receive(envelope, "ready");
    await until(() => boundary.sent.mock.calls.some(([e]) => e.event === "commit"));
    receive(envelope, "committed"); await run;
    const latest = { activeNoteId: "note-latest", draft: { noteId: "note-latest", body: "Child 中文 draft", newStep: "Unsubmitted child step" } };
    receive(envelope, "snapshot", latest, 9);
    receive(envelope, "snapshot", { activeNoteId: "stale", draft: null }, 8);
    for (const fn of boundary.destroyed) fn({ payload: { windowLabel: envelope.windowLabel, operationId: "old-operation" } });
    expect(boundary.restore).not.toHaveBeenCalled();
    expect(useNotesWindowStore.getState().phase).toBe("detached");
    const surface = document.createElement("div"); surface.dataset.surfaceId = "notes";
    const panel = document.createElement("div"); panel.dataset.testid = "notes-panel"; surface.appendChild(panel); document.body.appendChild(surface);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 300, height: 400 } as DOMRect);
    for (const fn of boundary.destroyed) fn({ payload: { windowLabel: envelope.windowLabel, operationId: envelope.operationId } });
    await until(() => boundary.restore.mock.calls.length === 1 && useNotesWindowStore.getState().phase === "docked");
    expect(boundary.restore).toHaveBeenCalledWith(latest);
    expect(useNotesStore.getState().panelMode).toBe("hub");
    expect(useNotesWindowStore.getState().recovery).toBeTruthy();
    await until(() => boundary.sent.mock.calls.some(([e]) => e.event === "reattached"));
    for (const fn of boundary.destroyed) fn({ payload: { windowLabel: envelope.windowLabel, operationId: envelope.operationId } });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    off(); expect(boundary.destroyed.size).toBe(0);
  });
});

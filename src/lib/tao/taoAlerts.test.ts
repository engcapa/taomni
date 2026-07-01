import { describe, expect, it } from "vitest";
import {
  alertColorBucket,
  buildTaoAlerts,
  noteAlertToTao,
  ribbonAlertState,
  taoAlertPriority,
  topAlertKind,
  type TaoAlert,
} from "./taoAlerts";
import type { NoteAlert } from "../notes";

function noteAlert(over: Partial<NoteAlert>): NoteAlert {
  return {
    id: "e1",
    note_id: "n1",
    kind: "overdue",
    state: "pending",
    fire_at: 100,
    acknowledged_at: null,
    note_title: "Note",
    due_at: 100,
    reminder_at: null,
    ...over,
  };
}

describe("taoAlerts", () => {
  it("orders kinds overdue > due_soon > reminder > ai_done > mail", () => {
    expect(taoAlertPriority("note_overdue")).toBeLessThan(taoAlertPriority("note_due_soon"));
    expect(taoAlertPriority("note_due_soon")).toBeLessThan(taoAlertPriority("note_reminder"));
    expect(taoAlertPriority("note_reminder")).toBeLessThan(taoAlertPriority("ai_done"));
    expect(taoAlertPriority("ai_done")).toBeLessThan(taoAlertPriority("mail_new"));
  });

  it("maps notes alerts into the unified model with a note: id prefix", () => {
    const tao = noteAlertToTao(noteAlert({ id: "evt", note_id: "note-9", kind: "due_soon", note_title: "Ship it" }));
    expect(tao).toMatchObject({
      id: "note:evt",
      source: "notes",
      kind: "note_due_soon",
      noteId: "note-9",
      title: "Ship it",
    });
  });

  it("drops acknowledged notes alerts and sorts by priority then fire time", () => {
    const notes: NoteAlert[] = [
      noteAlert({ id: "soon", kind: "due_soon", fire_at: 50 }),
      noteAlert({ id: "ackd", kind: "overdue", state: "acknowledged" }),
      noteAlert({ id: "over", kind: "overdue", fire_at: 10 }),
    ];
    const ai: TaoAlert[] = [
      { id: "chat:t1", source: "chat", kind: "ai_done", title: "AI", threadId: "t1", fireAt: 5 },
    ];
    const built = buildTaoAlerts(notes, ai);
    // acknowledged one is dropped; overdue first, then due_soon, then ai_done.
    expect(built.map((a) => a.id)).toEqual(["note:over", "note:soon", "chat:t1"]);
  });

  it("summarizes ribbon state: idle / single-kind / multiple", () => {
    expect(ribbonAlertState([])).toBe("idle");
    expect(
      ribbonAlertState([{ id: "chat:t1", source: "chat", kind: "ai_done", title: "x", threadId: "t1", fireAt: 1 }]),
    ).toBe("ai_done");
    const two = buildTaoAlerts([noteAlert({ id: "o" }), noteAlert({ id: "s", kind: "due_soon" })], []);
    expect(ribbonAlertState(two)).toBe("multiple");
  });

  it("buckets colors by severity", () => {
    expect(alertColorBucket(topAlertKind([]))).toBe("none");
    expect(alertColorBucket("note_overdue")).toBe("red");
    expect(alertColorBucket("note_due_soon")).toBe("amber");
    expect(alertColorBucket("note_reminder")).toBe("amber");
    expect(alertColorBucket("ai_done")).toBe("accent");
  });
});

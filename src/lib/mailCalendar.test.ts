import { describe, expect, it } from "vitest";
import { agendaKey, agendaStart, agendaTimeLabel, dueReminders, groupAgendaByDay, type MailAgendaEvent } from "./mailCalendar";

function event(partial: Partial<MailAgendaEvent>): MailAgendaEvent {
  return { uid: "e", summary: "Event", startLocal: "", allDay: false, instance: "", ...partial };
}

describe("mailCalendar", () => {
  it("resolves starts for UTC, zoned and all-day events", () => {
    expect(agendaStart(event({ start: 1_700_000_000, startLocal: "2023-11-14T22:13" }))?.getTime()).toBe(1_700_000_000_000);
    expect(agendaStart(event({ startLocal: "2026-10-05T10:30", tzid: "China Standard Time" }))).toEqual(new Date(2026, 9, 5, 10, 30));
    expect(agendaStart(event({ startLocal: "2026-10-05", allDay: true, start: 1 }))).toEqual(new Date(2026, 9, 5));
    expect(agendaTimeLabel(event({ startLocal: "2026-10-05", allDay: true }))).toBe("All day");
    expect(agendaTimeLabel(event({ startLocal: "2026-10-05T10:30", tzid: "CST" }))).toContain("(CST)");
  });

  it("groups by local day in order", () => {
    const groups = groupAgendaByDay([
      event({ uid: "b", startLocal: "2026-10-06T09:00" }),
      event({ uid: "a", startLocal: "2026-10-05T18:00" }),
      event({ uid: "c", startLocal: "2026-10-05T08:00" }),
    ]);
    expect(groups.map((group) => group.day)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(groups[0].events.map((e) => e.uid)).toEqual(["c", "a"]);
  });

  it("finds due reminders once", () => {
    const now = Date.UTC(2026, 9, 5, 1, 0);
    const soon = event({ uid: "soon", start: now / 1000 + 10 * 60, startLocal: "x" });
    const custom = event({ uid: "custom", start: now / 1000 + 50 * 60, startLocal: "x", alarmMinutes: 60 });
    const later = event({ uid: "later", start: now / 1000 + 3 * 3600, startLocal: "x" });
    const started = event({ uid: "started", start: now / 1000 - 60, startLocal: "x" });
    const due = dueReminders([soon, custom, later, started], now, new Set());
    expect(due.map((e) => e.uid)).toEqual(["soon", "custom"]);
    expect(dueReminders([soon], now, new Set([agendaKey(soon)]))).toEqual([]);
  });
});

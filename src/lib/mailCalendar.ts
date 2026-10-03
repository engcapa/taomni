import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../types";
import { withVaultLockedNotice } from "./ipc";

/** Upcoming CalDAV event (TASK-20 phase 2); mirrors src-tauri/src/mail/caldav.rs. */
export interface MailAgendaEvent {
  uid: string;
  summary: string;
  location?: string | null;
  /** Epoch seconds when known (UTC and server-expanded instances). */
  start?: number | null;
  end?: number | null;
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as written. */
  startLocal: string;
  tzid?: string | null;
  allDay: boolean;
  /** Minutes before the start of the first alarm. */
  alarmMinutes?: number | null;
  instance: string;
}

export interface MailCalDavSyncResult {
  collection: string;
  events: number;
  errors: string[];
}

export interface MailCalendarWriteResult {
  href: string;
  created: boolean;
}

/** Reminder lead time when an event has no alarm of its own. */
export const DEFAULT_REMINDER_MINUTES = 15;

export function agendaKey(event: MailAgendaEvent): string {
  return `${event.uid}\u0000${event.instance || event.startLocal}`;
}

/** Start as a Date in local time (floating/zoned values use their wall clock). */
export function agendaStart(event: MailAgendaEvent): Date | null {
  if (event.start != null && !event.allDay) return new Date(event.start * 1000);
  const [date, time] = event.startLocal.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  const [hour, minute] = (time ?? "00:00").split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

/** Events grouped by local day, soonest first. */
export function groupAgendaByDay(events: MailAgendaEvent[]): { day: string; label: string; events: MailAgendaEvent[] }[] {
  const groups = new Map<string, MailAgendaEvent[]>();
  const sorted = [...events].sort((a, b) => (agendaStart(a)?.getTime() ?? 0) - (agendaStart(b)?.getTime() ?? 0));
  for (const event of sorted) {
    const start = agendaStart(event);
    const day = start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}` : event.startLocal.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  return [...groups.entries()].map(([day, list]) => {
    const [year, month, date] = day.split("-").map(Number);
    const label = new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    return { day, label, events: list };
  });
}

export function agendaTimeLabel(event: MailAgendaEvent): string {
  if (event.allDay) return "All day";
  const start = agendaStart(event);
  if (!start) return event.startLocal;
  const time = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return event.start == null && event.tzid ? `${time} (${event.tzid})` : time;
}

/** Events whose reminder is due at `now` (ms) and that have not started yet. */
export function dueReminders(events: MailAgendaEvent[], now: number, notified: Set<string>): MailAgendaEvent[] {
  return events.filter((event) => {
    if (event.allDay || notified.has(agendaKey(event))) return false;
    const start = agendaStart(event)?.getTime();
    if (start == null) return false;
    const lead = (event.alarmMinutes ?? DEFAULT_REMINDER_MINUTES) * 60_000;
    return now >= start - lead && now < start;
  });
}

export function mailCalDavSync(config: MailTabInfo): Promise<MailCalDavSyncResult> {
  return withVaultLockedNotice(() => invoke<MailCalDavSyncResult>("mail_caldav_sync", { config }));
}

export function mailListAgenda(accountId: string, days = 14): Promise<MailAgendaEvent[]> {
  return invoke<MailAgendaEvent[]>("mail_list_agenda", { accountId, days });
}

export function mailAddInviteToCalendar(
  config: MailTabInfo,
  folder: string,
  uid: number,
  partstat?: string | null,
): Promise<MailCalendarWriteResult> {
  return withVaultLockedNotice(() =>
    invoke<MailCalendarWriteResult>("mail_add_invite_to_calendar", { config, folder, uid, partstat: partstat ?? null }),
  );
}

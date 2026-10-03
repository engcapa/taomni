// Browser-preview model of the CalDAV agenda (src-tauri/src/mail/caldav.rs):
// accepted invitations land in a per-account event list. There is no server
// behind it; the Rust tests cover CalDAV parsing and resource writes.

import type { MailAgendaEvent } from "../lib/mailCalendar";
import type { StubMailInvite } from "./mailServerStub";

/** Stored events keep the reply the stub "wrote" into the calendar. */
const agendas = new Map<string, (MailAgendaEvent & { partstat?: string | null })[]>();

export function stubListAgenda(accountId: string, days: number): MailAgendaEvent[] {
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + days * 86_400;
  return (agendas.get(accountId) ?? [])
    .filter((event) => event.start == null || (event.start <= horizon && (event.end ?? event.start) >= now))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .map((event) => ({ ...event }));
}

export function stubAddInviteToCalendar(
  accountId: string,
  invite: StubMailInvite,
  partstat?: string | null,
): { href: string; created: boolean } {
  const list = agendas.get(accountId) ?? [];
  const created = !list.some((event) => event.uid === invite.uid);
  const event: MailAgendaEvent & { partstat?: string | null } = {
    uid: invite.uid,
    summary: invite.summary,
    location: invite.location,
    start: invite.start.epoch,
    end: invite.end.epoch,
    startLocal: invite.start.local,
    tzid: invite.start.tzid,
    allDay: invite.start.allDay,
    alarmMinutes: null,
    instance: "",
    partstat: partstat ?? null,
  };
  agendas.set(accountId, [...list.filter((item) => item.uid !== invite.uid), event]);
  return { href: `/stub/calendar/${encodeURIComponent(invite.uid)}.ics`, created };
}

/** Text of every stored event (QA: "calendar holds the event"). */
export function stubAgendaTexts(): string[] {
  return [...agendas.values()].flat().map((event) => `${event.uid} ${event.summary} PARTSTAT=${event.partstat ?? ""}`);
}

export function stubCalDavSync(accountId: string, url: string) {
  return { collection: url, events: (agendas.get(accountId) ?? []).length, errors: [] as string[] };
}

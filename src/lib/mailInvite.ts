import type { MailAttachmentInfo, MailInvite, MailInviteTime } from "./mail";

/** True when the message body lists an iCalendar part worth parsing. */
export function hasCalendarPart(attachments: MailAttachmentInfo[] | null | undefined): boolean {
  return (attachments ?? []).some((attachment) => {
    const type = (attachment.contentType ?? "").toLowerCase();
    const name = (attachment.name ?? "").toLowerCase();
    return type === "text/calendar" || type === "application/ics" || name.endsWith(".ics");
  });
}

/** Human-readable time: exact local time for UTC values, else wall clock + zone. */
export function formatInviteTime(time: MailInviteTime | null | undefined, locale?: string): string {
  if (!time) return "";
  if (time.allDay) {
    const [year, month, day] = time.local.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(locale, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  if (time.epoch != null) {
    return new Date(time.epoch * 1000).toLocaleString(locale, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const text = time.local.replace("T", " ");
  return time.tzid ? `${text} (${time.tzid})` : text;
}

/** Time range; the end drops its date when it matches the start's. */
export function formatInviteRange(invite: MailInvite, locale?: string): string {
  const start = formatInviteTime(invite.start, locale);
  const end = formatInviteTime(invite.end, locale);
  if (!end || end === start) return start;
  if (
    invite.start && invite.end && !invite.start.allDay && invite.start.epoch == null &&
    invite.start.local.slice(0, 10) === invite.end.local.slice(0, 10)
  ) {
    return `${start.replace(/ \(.*\)$/, "")} – ${invite.end.local.slice(11)}${invite.end.tzid ? ` (${invite.end.tzid})` : ""}`;
  }
  return `${start} – ${end}`;
}

/** My PARTSTAT in the invitation, matched by account address. */
export function myPartstat(invite: MailInvite, myAddress: string): string | null {
  const me = myAddress.trim().toLowerCase();
  if (!me) return null;
  return invite.attendees.find((attendee) => attendee.email.toLowerCase() === me)?.partstat ?? null;
}

/** `.ics` file name for "Export" from the event summary. */
export function inviteFileName(invite: MailInvite): string {
  const base = invite.summary.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 80);
  return `${base || "invite"}.ics`;
}

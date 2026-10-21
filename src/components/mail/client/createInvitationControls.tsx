import { type SetStateAction } from "react";
import { CalendarDays, Download, ExternalLink, Loader2 } from "lucide-react";
import { mailRespondInvite, type MailInvite, type MailInviteReply, type MailMessageHeader } from "../../../lib/mail";
import { formatInviteRange, hasCalendarPart, myPartstat } from "../../../lib/mailInvite";
import { mailAddInviteToCalendar } from "../../../lib/mailCalendar";
import { messageKey, mailClientErrorMessage } from "./messages";


export interface CreateInvitationControlsContext {
  setInviteView: import("react").Dispatch<SetStateAction<{ key: string; invite: MailInvite | null; loading: boolean; responding?: MailInviteReply; responded?: string; error?: string; calendar?: "adding" | "added"; calendarError?: string; } | null>>;
  info: import("../../../types").MailTabInfo;
  setAgendaRevision: import("react").Dispatch<SetStateAction<number>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  inviteView: { key: string; invite: MailInvite | null; loading: boolean; responding?: MailInviteReply; responded?: string; error?: string; calendar?: "adding" | "added"; calendarError?: string; } | null;
  visibleAttachments: import("../../../lib/mail").MailAttachmentInfo[];
  handleDownloadAttachment: (message: MailMessageHeader, attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => Promise<void>;
  handleOpenAttachment: (message: MailMessageHeader, attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => Promise<void>;
}

export function createInvitationControls(context: CreateInvitationControlsContext) {
  const { setInviteView, info, setAgendaRevision, setStatus, inviteView, visibleAttachments, handleDownloadAttachment, handleOpenAttachment } = context;

  /** DEC-14: put the invitation (with my reply) into the CalDAV calendar. */
  const addInviteToCalendar = async (message: MailMessageHeader, partstat?: string) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, calendar: "adding", calendarError: undefined } : current));
    try {
      const written = await mailAddInviteToCalendar(info, message.folder, message.uid, partstat);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: "added" } : current));
      setAgendaRevision((value) => value + 1);
      setStatus(written.created ? "Added to your calendar" : "Updated in your calendar");
    } catch (e) {
      const calendarError = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: undefined, calendarError } : current));
    }
  };

  /** AC-62: Accept / Tentative / Decline sends an iTIP REPLY to the organizer. */
  const handleRespondInvite = async (message: MailMessageHeader, response: MailInviteReply) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, responding: response, error: undefined } : current));
    try {
      const result = await mailRespondInvite(info, message.folder, message.uid, response);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, responded: result.partstat } : current));
      setStatus(`Invitation reply (${result.partstat.toLowerCase()}) sent to ${result.sentTo}`);
      if (info.caldav && response !== "decline") await addInviteToCalendar(message, result.partstat);
    } catch (e) {
      const error = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, error } : current));
    }
  };

  const renderInviteCard = (message: MailMessageHeader) => {
    const view = inviteView;
    if (!view || view.key !== messageKey(message)) return null;
    if (view.loading) {
      return (
        <div className="mx-4 mt-3 flex items-center gap-2 text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-invite-loading">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading calendar invitation…
        </div>
      );
    }
    const invite = view.invite;
    if (!invite) {
      return view.error ? (
        <div className="mx-4 mt-3 text-[12px] text-red-500" data-testid="mail-invite-error">{view.error}</div>
      ) : null;
    }
    const cancelled = invite.method === "CANCEL" || invite.status === "CANCELLED";
    const canRespond = invite.method === "REQUEST" && !cancelled && !!invite.organizer;
    const current = view.responded ?? myPartstat(invite, info.emailAddress);
    const calendarIndex = visibleAttachments.findIndex((attachment) => hasCalendarPart([attachment]));
    const replies: Array<{ response: MailInviteReply; label: string; partstat: string; }> = [
      { response: "accept", label: "Accept", partstat: "ACCEPTED" },
      { response: "tentative", label: "Tentative", partstat: "TENTATIVE" },
      { response: "decline", label: "Decline", partstat: "DECLINED" },
    ];
    return (
      <div
        className="mx-4 mt-3 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-3 text-[12px]"
        data-testid="mail-invite-card"
        data-method={invite.method}
        data-partstat={current ?? undefined}
      >
        <div className="flex items-start gap-2">
          <CalendarDays className="w-4 h-4 mt-0.5 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold break-words" data-testid="mail-invite-summary">
              {cancelled ? "Cancelled: " : invite.method === "REPLY" ? "Reply: " : ""}{invite.summary || "(untitled event)"}
            </div>
            <div className="mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5">
              <span className="text-[var(--taomni-text-muted)]">When</span>
              <span data-testid="mail-invite-when">{formatInviteRange(invite) || "(not specified)"}</span>
              {invite.location && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Where</span>
                  <span className="break-words">{invite.location}</span>
                </>
              )}
              {invite.organizer && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Organizer</span>
                  <span className="truncate">{invite.organizer.name ? `${invite.organizer.name} <${invite.organizer.email}>` : invite.organizer.email}</span>
                </>
              )}
              {invite.attendees.length > 0 && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Attendees</span>
                  <span className="break-words">
                    {invite.attendees.map((attendee) => `${attendee.name || attendee.email} (${attendee.partstat.toLowerCase()})`).join(", ")}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canRespond && replies.map((reply) => (
            <button
              key={reply.response}
              type="button"
              className={`taomni-btn h-6 px-2 text-[11px] ${current === reply.partstat ? "text-[var(--taomni-accent)] border-[var(--taomni-accent)]" : ""}`}
              data-testid={`mail-invite-${reply.response}`}
              aria-pressed={current === reply.partstat}
              disabled={!!view.responding}
              onClick={() => void handleRespondInvite(message, reply.response)}
            >
              {view.responding === reply.response ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {reply.label}
            </button>
          ))}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-export"
              title="Save the event as an .ics file"
              onClick={() => void handleDownloadAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <Download className="w-3 h-3" /> Export .ics
            </button>
          )}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-open"
              title="Open in the system calendar app"
              onClick={() => void handleOpenAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <ExternalLink className="w-3 h-3" /> Open in calendar
            </button>
          )}
          {info.caldav && invite.method === "REQUEST" && !cancelled && view.calendar !== "added" && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              data-testid="mail-invite-add-calendar"
              disabled={view.calendar === "adding"}
              onClick={() => void addInviteToCalendar(message, view.responded)}
            >
              {view.calendar === "adding" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarDays className="w-3 h-3" />} Add to calendar
            </button>
          )}
          {view.responded && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-responded">
              Reply sent ({view.responded.toLowerCase()})
            </span>
          )}
          {view.calendar === "added" && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-in-calendar">In your calendar</span>
          )}
        </div>
        {view.error && <div className="mt-1 text-red-500" data-testid="mail-invite-error">{view.error}</div>}
        {view.calendarError && <div className="mt-1 text-red-500" data-testid="mail-invite-calendar-error">{view.calendarError}</div>}
      </div>
    );
  };
  return { renderInviteCard };
}

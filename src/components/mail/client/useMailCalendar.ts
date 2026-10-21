import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { notifyDesktop } from "../../../lib/lanNotify";
import { mailGetInvite, type MailInvite, type MailInviteReply, type MailMessageHeader } from "../../../lib/mail";
import { agendaKey, agendaTimeLabel, dueReminders, mailCalDavSync, mailListAgenda, type MailAgendaEvent } from "../../../lib/mailCalendar";
import { hasCalendarPart } from "../../../lib/mailInvite";
import { mailClientErrorMessage, messageKey } from "./messages";

export interface UseMailCalendarContext {
  info: import("../../../types").MailTabInfo;
  selectedMessage: MailMessageHeader | null;
  visibleAttachments: import("../../../lib/mail").MailAttachmentInfo[];
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}

export function useMailCalendar(context: UseMailCalendarContext) {
  const { info, selectedMessage, visibleAttachments, setStatus } = context;
  /** CalDAV agenda (DEC-14): dialog, cache revision and reminder bookkeeping. */
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaRevision, setAgendaRevision] = useState(0);
  const agendaEventsRef = useRef<MailAgendaEvent[]>([]);
  const remindedRef = useRef<Set<string>>(new Set());
  /** Calendar invitation of the open message (TASK-20), keyed by message. */
  const [inviteView, setInviteView] = useState<{
    key: string;
    invite: MailInvite | null;
    loading: boolean;
    responding?: MailInviteReply;
    responded?: string;
    error?: string;
    /** CalDAV write of the invitation (TASK-20 phase 2). */
    calendar?: "adding" | "added";
    calendarError?: string;
  } | null>(null);
  // AC-62: parse the invitation once the body shows a calendar part.
  const inviteInfoRef = useRef(info);
  inviteInfoRef.current = info;
  const selectedInviteKey = selectedMessage && hasCalendarPart(visibleAttachments)
    ? messageKey(selectedMessage)
    : null;
  useEffect(() => {
    if (!selectedInviteKey || !selectedMessage) {
      setInviteView(null);
      return;
    }
    let cancelled = false;
    const { folder, uid } = selectedMessage;
    setInviteView({ key: selectedInviteKey, invite: null, loading: true });
    mailGetInvite(inviteInfoRef.current, folder, uid)
      .then((invite) => {
        if (!cancelled) setInviteView({ key: selectedInviteKey, invite, loading: false });
      })
      .catch((e) => {
        if (!cancelled) {
          setInviteView({ key: selectedInviteKey, invite: null, loading: false, error: mailClientErrorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
    // selectedMessage is identified by selectedInviteKey.
  }, [selectedInviteKey]);

  // DEC-14: reminders for CalDAV events while this tab is open (DEC-01).
  const caldavUrl = info.caldav?.url ?? "";
  const onAgendaChanged = useCallback((events: MailAgendaEvent[]) => {
    agendaEventsRef.current = events;
  }, []);
  useEffect(() => {
    if (!caldavUrl) return;
    let cancelled = false;
    const refresh = async (sync: boolean) => {
      try {
        if (sync) await mailCalDavSync(inviteInfoRef.current);
        const events = await mailListAgenda(inviteInfoRef.current.sessionId, 2);
        if (!cancelled) agendaEventsRef.current = events;
      } catch (e) {
        console.debug("mail agenda refresh failed", e);
      }
    };
    void refresh(false);
    const firstSync = window.setTimeout(() => void refresh(true), 5_000);
    const syncTimer = window.setInterval(() => void refresh(true), 15 * 60_000);
    const reminderTimer = window.setInterval(() => {
      for (const event of dueReminders(agendaEventsRef.current, Date.now(), remindedRef.current)) {
        remindedRef.current.add(agendaKey(event));
        const when = agendaTimeLabel(event);
        setStatus(`Reminder: ${event.summary || "event"} at ${when}`);
        void notifyDesktop(
          `Reminder: ${event.summary || "Event"}`,
          event.location ? `${when} · ${event.location}` : when,
        );
      }
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstSync);
      window.clearInterval(syncTimer);
      window.clearInterval(reminderTimer);
    };
  }, [caldavUrl]);
  useEffect(() => {
    if (!caldavUrl || agendaRevision === 0) return;
    void mailListAgenda(inviteInfoRef.current.sessionId, 2)
      .then((events) => {
        agendaEventsRef.current = events;
      })
      .catch(() => undefined);
  }, [agendaRevision, caldavUrl]);
  return { setInviteView, setAgendaRevision, inviteView, setAgendaOpen, agendaOpen, agendaRevision, onAgendaChanged };
}

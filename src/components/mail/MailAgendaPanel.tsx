import { useCallback, useEffect, useState } from "react";
import { Bell, Loader2, MapPin, RefreshCw } from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  agendaKey,
  agendaTimeLabel,
  groupAgendaByDay,
  mailCalDavSync,
  mailListAgenda,
  type MailAgendaEvent,
} from "../../lib/mailCalendar";

export interface MailAgendaPanelProps {
  info: MailTabInfo;
  /** Bumped by the tab when the agenda cache changed (sync, accepted invite). */
  revision?: number;
  onStatus?: (message: string) => void;
  onChanged?: (events: MailAgendaEvent[]) => void;
}

/** Upcoming CalDAV events of the account (DEC-14: list, no calendar grid). */
export function MailAgendaPanel({ info, revision = 0, onStatus, onChanged }: MailAgendaPanelProps) {
  const [events, setEvents] = useState<MailAgendaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await mailListAgenda(info.sessionId, 14);
      setEvents(list);
      onChanged?.(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [info.sessionId, onChanged]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await mailCalDavSync(info);
      if (result.errors.length) setError(result.errors.join("; "));
      else onStatus?.(`Calendar synced: ${result.events} event${result.events === 1 ? "" : "s"} in the next weeks`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const groups = groupAgendaByDay(events);
  return (
    <div className="flex-1 min-h-0 flex flex-col text-[12px]" data-testid="mail-agenda">
      <div className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
        <span className="text-[var(--taomni-text-muted)] truncate" title={info.caldav?.url}>Next 14 days · {info.caldav?.url}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          data-testid="mail-agenda-sync"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync
        </button>
      </div>
      {error && <div className="px-3 py-1.5 text-red-500 border-b border-[var(--taomni-divider)]" data-testid="mail-agenda-error">{error}</div>}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {loading ? (
          <div className="p-3 flex items-center gap-2 text-[var(--taomni-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading agenda…</div>
        ) : groups.length === 0 ? (
          <div className="p-3 text-[var(--taomni-text-muted)]" data-testid="mail-agenda-empty">
            No upcoming events. Use Sync to read the calendar, or accept an invitation.
          </div>
        ) : groups.map((group) => (
          <section key={group.day} className="mb-2">
            <h3 className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">{group.label}</h3>
            {group.events.map((event) => (
              <div
                key={agendaKey(event)}
                className="px-2 py-1.5 flex items-start gap-3 rounded hover:bg-[var(--taomni-hover)]"
                data-testid="mail-agenda-event"
                data-summary={event.summary}
              >
                <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">{agendaTimeLabel(event)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{event.summary || "(untitled event)"}</div>
                  {event.location && (
                    <div className="truncate text-[11px] text-[var(--taomni-text-muted)] inline-flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> {event.location}
                    </div>
                  )}
                </div>
                {event.alarmMinutes != null && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-[var(--taomni-text-muted)]" title="Reminder">
                    <Bell className="w-3 h-3" /> {event.alarmMinutes}m
                  </span>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

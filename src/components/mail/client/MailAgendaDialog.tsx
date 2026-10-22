import { CalendarDays } from "lucide-react";
import { type SetStateAction } from "react";
import { MailAgendaPanel } from "../MailAgendaPanel";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailAgendaDialogContext {
  agendaOpen: boolean;
  info: import("../../../types").MailTabInfo;
  setAgendaOpen: import("react").Dispatch<SetStateAction<boolean>>;
  agendaRevision: number;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  onAgendaChanged: (events: import("../../../lib/mailCalendar").MailAgendaEvent[]) => void;
}

export function MailAgendaDialog(context: MailAgendaDialogContext) {
  const { agendaOpen, info, setAgendaOpen, agendaRevision, setStatus, onAgendaChanged } = context;
  return agendaOpen && info.caldav && (
    <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
      <MailDraggableDialog
        title="Agenda"
        icon={<CalendarDays className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Agenda"
        closeTestId="mail-agenda-close"
        minWidth={380}
        minHeight={300}
        className="w-[min(560px,92vw)] h-[min(520px,80vh)] min-h-[320px]"
        onClose={() => setAgendaOpen(false)}
      >
        <MailAgendaPanel
          info={info}
          revision={agendaRevision}
          onStatus={setStatus}
          onChanged={onAgendaChanged}
        />
      </MailDraggableDialog>
    </div>
  );
}

import { MailOpen } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailMessageHeader } from "../../../lib/mail";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailMessagePopupContext {
  popupMessage: MailMessageHeader | null;
  setPopupMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  openMessageTab: (message: MailMessageHeader) => void;
  renderReaderSurface: (message: MailMessageHeader | null, popup?: boolean) => import("react").JSX.Element;
}

export function MailMessagePopup(context: MailMessagePopupContext) {
  const { popupMessage, setPopupMessageKey, openMessageTab, renderReaderSurface } = context;
  return popupMessage && (
    <div className="absolute inset-0 z-[130] bg-black/35 flex items-center justify-center p-5">
      <MailDraggableDialog
        title={popupMessage.subject || "(no subject)"}
        icon={<MailOpen className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel={popupMessage.subject || "Mail message"}
        minWidth={640}
        minHeight={420}
        className="w-[min(1120px,92vw)] h-[min(780px,86vh)] min-h-[480px]"
        onClose={() => setPopupMessageKey(null)}
        headerActions={(
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            onClick={() => openMessageTab(popupMessage)}
          >
            Open tab
          </button>
        )}
      >
        <div className="flex-1 min-h-0">
          {renderReaderSurface(popupMessage, true)}
        </div>
      </MailDraggableDialog>
    </div>
  );
}

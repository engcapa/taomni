import { BookUser } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailAddressBookEntry } from "../../../lib/mailContacts";
import { parseRecipientsText } from "../../../lib/mailRecipients";
import { MailAddressBookPanel } from "../MailAddressBookPanel";
import { MailDraggableDialog } from "./MailDraggableDialog";
import { type ComposeDraft } from "./types";

export interface MailAddressBookDialogContext {
  addressBookOpen: boolean;
  setAddressBookOpen: import("react").Dispatch<SetStateAction<boolean>>;
  info: import("../../../types").MailTabInfo;
  contactDraft: MailAddressBookEntry | null;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  openCompose: (nextDraft?: Partial<ComposeDraft>, includeSignature?: boolean) => void;
}

export function MailAddressBookDialog(context: MailAddressBookDialogContext) {
  const { addressBookOpen, setAddressBookOpen, info, contactDraft, setStatus, openCompose } = context;
  return addressBookOpen && (
    <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
      <MailDraggableDialog
        title="Address book"
        icon={<BookUser className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Address book"
        closeTestId="mail-address-book-close"
        minWidth={420}
        minHeight={320}
        className="w-[min(640px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
        onClose={() => setAddressBookOpen(false)}
      >
        <MailAddressBookPanel
          info={info}
          initialDraft={contactDraft}
          onStatus={setStatus}
          onCompose={(entry) => {
            setAddressBookOpen(false);
            openCompose({ to: parseRecipientsText(entry.displayName ? `${entry.displayName} <${entry.emails[0]}>` : entry.emails[0]) });
          }}
        />
      </MailDraggableDialog>
    </div>
  );
}

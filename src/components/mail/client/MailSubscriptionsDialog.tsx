import { ListChecks, Loader2 } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailFolder } from "../../../lib/mail";
import { folderLabel, isSelectable, isSubscribed } from "../../../lib/mailFolders";
import { folderDepth, folderIcon } from "./folders";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailSubscriptionsDialogContext {
  subscriptionsOpen: boolean;
  setSubscriptionsOpen: import("react").Dispatch<SetStateAction<boolean>>;
  subscribedOnly: boolean;
  setSubscribedOnly: (value: boolean) => void;
  displayFolders: MailFolder[];
  subscriptionBusy: string | null;
  toggleSubscription: (folder: MailFolder, subscribed: boolean) => Promise<void>;
}

export function MailSubscriptionsDialog(context: MailSubscriptionsDialogContext) {
  const { subscriptionsOpen, setSubscriptionsOpen, subscribedOnly, setSubscribedOnly, displayFolders, subscriptionBusy, toggleSubscription } = context;
  return subscriptionsOpen && (
    <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
      <MailDraggableDialog
        title="Folder subscriptions"
        icon={<ListChecks className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Folder subscriptions"
        minWidth={360}
        minHeight={280}
        className="w-[min(520px,90vw)] h-[min(520px,78vh)] min-h-[300px]"
        onClose={() => setSubscriptionsOpen(false)}
      >
        <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={subscribedOnly}
              data-testid="mail-subscribed-only"
              onChange={(event) => setSubscribedOnly(event.target.checked)}
            />
            Show only subscribed folders
          </label>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-subscriptions-dialog">
          {displayFolders.filter(isSelectable).map((folder) => {
            const subscribed = isSubscribed(folder);
            const inbox = folder.name.toUpperCase() === "INBOX";
            return (
              <label
                key={folder.name}
                className="h-7 px-2 flex items-center gap-2 rounded text-[12px] hover:bg-[var(--taomni-hover)]"
                style={{ paddingLeft: `${8 + Math.min(folderDepth(folder), 6) * 14}px` }}
                data-testid="mail-subscription-row"
                data-folder-name={folder.name}
                data-subscribed={subscribed ? "true" : "false"}
              >
                <input
                  type="checkbox"
                  checked={subscribed}
                  disabled={inbox || subscriptionBusy != null}
                  aria-label={`Subscribe to ${folderLabel(folder)}`}
                  data-testid="mail-subscription-toggle"
                  onChange={(event) => void toggleSubscription(folder, event.target.checked)}
                />
                <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                <span className="min-w-0 flex-1 truncate">{folderLabel(folder)}</span>
                {subscriptionBusy === folder.name && <Loader2 className="w-3 h-3 animate-spin" />}
              </label>
            );
          })}
        </div>
      </MailDraggableDialog>
    </div>
  );
}

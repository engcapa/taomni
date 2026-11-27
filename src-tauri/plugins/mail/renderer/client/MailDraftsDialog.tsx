import { useT } from "../../../../../src/lib/i18n";
import { SectionTabs, sectionTab } from "../../../../crates/taomni-plugin-api/frontend/ui/SectionTabs";
import { IconButton } from "../../../../crates/taomni-plugin-api/frontend/ui/IconButton";
import { FileText, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailDraft } from "../../../../../src/lib/mail";
import { isOutbox, outboxNextAttemptAt, outboxState } from "../../../../../src/lib/mailOutbox";
import { isTemplate } from "./compose";
import { MailDraggableDialog } from "./MailDraggableDialog";
import { formatShortDate } from "./messages";

export interface MailDraftsDialogContext {
  draftsOpen: boolean;
  draftsTab: "drafts" | "templates" | "outbox";
  setDraftsOpen: import("react").Dispatch<SetStateAction<boolean>>;
  refreshDrafts: () => Promise<void>;
  draftsLoading: boolean;
  setDraftsTab: import("react").Dispatch<SetStateAction<"drafts" | "templates" | "outbox">>;
  outboxCount: number;
  visibleDrafts: MailDraft[];
  processOutbox: (all?: boolean) => Promise<void>;
  openFromTemplate: (template: MailDraft) => void;
  openSavedDraft: (saved: MailDraft) => void;
  sendOutboxItem: (saved: MailDraft, manual?: boolean) => Promise<boolean>;
  deleteSavedDraft: (saved: MailDraft) => Promise<void>;
}

export function MailDraftsDialog(context: MailDraftsDialogContext) {
  const t = useT();
  const {
    draftsOpen,
    draftsTab,
    setDraftsOpen,
    refreshDrafts,
    draftsLoading,
    setDraftsTab,
    outboxCount,
    visibleDrafts,
    processOutbox,
    openFromTemplate,
    openSavedDraft,
    sendOutboxItem,
    deleteSavedDraft,
  } = context;
  return draftsOpen && (
      <MailDraggableDialog
        title={draftsTab === "drafts" ? "Drafts" : draftsTab === "templates" ? "Templates" : "Outbox"}
        icon={<FileText className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Drafts and templates"
        minWidth={420}
        minHeight={300}
        className="w-[min(680px,90vw)] h-[min(520px,78vh)] min-h-[340px]"
        onClose={() => setDraftsOpen(false)}
      >
        <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
          <button type="button" className="taomni-btn h-7 px-2 text-ui-body" onClick={() => void refreshDrafts()} disabled={draftsLoading}>
            {draftsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <SectionTabs className="flex items-center gap-1" aria-label="Drafts and templates">
            {(["drafts", "templates", "outbox"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                {...sectionTab(draftsTab === tab)}
                data-testid={`mail-drafts-tab-${tab}`}
                className={`taomni-btn h-7 px-2 text-ui-body ${draftsTab === tab ? "text-[var(--taomni-accent)]" : ""}`}
                onClick={() => setDraftsTab(tab)}
              >
                {tab === "drafts" ? "Drafts" : tab === "templates" ? "Templates" : `Outbox${outboxCount > 0 ? ` (${outboxCount})` : ""}`}
              </button>
            ))}
          </SectionTabs>
          <span className="text-ui-body text-[var(--taomni-text-muted)]">
            {visibleDrafts.length} {draftsTab === "drafts" ? "draft" : draftsTab === "templates" ? "template" : "queued message"}{visibleDrafts.length === 1 ? "" : "s"}
          </span>
          {draftsTab === "outbox" && (
            <button
              type="button"
              className="taomni-btn h-7 px-2 text-ui-body ml-auto inline-flex items-center gap-1.5"
              data-testid="mail-outbox-send-all"
              disabled={visibleDrafts.length === 0}
              onClick={() => void processOutbox(true)}
              title="Send every queued message now"
            >
              <Send className="w-3.5 h-3.5" />
              Send all
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-drafts-dialog">
          {visibleDrafts.length === 0 ? (
            <div className="h-full flex items-center justify-center text-ui-body text-[var(--taomni-text-muted)]">
              {draftsTab === "drafts"
                ? "No saved drafts"
                : draftsTab === "templates"
                  ? "No templates. Use \"Save as template\" in the composer."
                  : "The Outbox is empty. Queued and scheduled messages send while this tab is open."}
            </div>
          ) : visibleDrafts.map((saved) => (
            <div
              key={saved.id}
              className="min-h-14 px-2 py-1.5 rounded border border-transparent hover:border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-2"
              data-testid={isOutbox(saved) ? "mail-outbox-row" : isTemplate(saved) ? "mail-template-row" : "mail-draft-row"}
              data-subject={saved.subject}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => (isTemplate(saved) ? openFromTemplate(saved) : openSavedDraft(saved))}
              >
                <div className="text-ui-body font-semibold truncate">{saved.subject || "(no subject)"}</div>
                <div className="text-ui-small text-[var(--taomni-text-muted)] truncate">
                  {[...saved.to, ...saved.cc, ...saved.bcc].join(", ") || "(no recipients)"}
                </div>
                {isOutbox(saved) && (() => {
                  const state = outboxState(saved)!;
                  const at = outboxNextAttemptAt(state);
                  return (
                    <div className="text-ui-caption text-[var(--taomni-text-muted)]" data-testid="mail-outbox-state">
                      {at ? `Sends ${new Date(at * 1000).toLocaleString()}` : "Waiting for Send now"}
                      {state.lastError ? ` · attempt ${state.attempts} failed: ${state.lastError}` : ""}
                    </div>
                  );
                })()}
                <div className="text-ui-caption text-[var(--taomni-text-muted)]">
                  {formatShortDate(saved.updatedAt)}
                  {saved.attachments.length > 0 ? ` · ${saved.attachments.length} attachment${saved.attachments.length === 1 ? "" : "s"}` : ""}
                </div>
              </button>
              {isOutbox(saved) && (
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-ui-body inline-flex items-center gap-1"
                  data-testid="mail-outbox-send"
                  title="Send this message now"
                  onClick={() => void sendOutboxItem(saved, true)}
                >
                  <Send className="w-3.5 h-3.5" />
                  Send now
                </button>
              )}
              <IconButton
                type="button"
                className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                label={t("iconActions.deleteDraft")}
                onClick={() => void deleteSavedDraft(saved)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
      </MailDraggableDialog>
  );
}

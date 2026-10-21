import { FileText, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailDraft } from "../../../lib/mail";
import { isOutbox, outboxNextAttemptAt, outboxState } from "../../../lib/mailOutbox";
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
    <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
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
          <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={() => void refreshDrafts()} disabled={draftsLoading}>
            {draftsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <div className="flex items-center gap-1" role="tablist" aria-label="Drafts and templates">
            {(["drafts", "templates", "outbox"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={draftsTab === tab}
                data-testid={`mail-drafts-tab-${tab}`}
                className={`taomni-btn h-7 px-2 text-[12px] ${draftsTab === tab ? "text-[var(--taomni-accent)]" : ""}`}
                onClick={() => setDraftsTab(tab)}
              >
                {tab === "drafts" ? "Drafts" : tab === "templates" ? "Templates" : `Outbox${outboxCount > 0 ? ` (${outboxCount})` : ""}`}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-[var(--taomni-text-muted)]">
            {visibleDrafts.length} {draftsTab === "drafts" ? "draft" : draftsTab === "templates" ? "template" : "queued message"}{visibleDrafts.length === 1 ? "" : "s"}
          </span>
          {draftsTab === "outbox" && (
            <button
              type="button"
              className="taomni-btn h-7 px-2 text-[12px] ml-auto inline-flex items-center gap-1.5"
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
            <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
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
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => (isTemplate(saved) ? openFromTemplate(saved) : openSavedDraft(saved))}
              >
                <div className="text-[12px] font-semibold truncate">{saved.subject || "(no subject)"}</div>
                <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                  {[...saved.to, ...saved.cc, ...saved.bcc].join(", ") || "(no recipients)"}
                </div>
                {isOutbox(saved) && (() => {
                  const state = outboxState(saved)!;
                  const at = outboxNextAttemptAt(state);
                  return (
                    <div className="text-[10px] text-[var(--taomni-text-muted)]" data-testid="mail-outbox-state">
                      {at ? `Sends ${new Date(at * 1000).toLocaleString()}` : "Waiting for Send now"}
                      {state.lastError ? ` · attempt ${state.attempts} failed: ${state.lastError}` : ""}
                    </div>
                  );
                })()}
                <div className="text-[10px] text-[var(--taomni-text-muted)]">
                  {formatShortDate(saved.updatedAt)}
                  {saved.attachments.length > 0 ? ` · ${saved.attachments.length} attachment${saved.attachments.length === 1 ? "" : "s"}` : ""}
                </div>
              </button>
              {isOutbox(saved) && (
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-[12px] inline-flex items-center gap-1"
                  data-testid="mail-outbox-send"
                  title="Send this message now"
                  onClick={() => void sendOutboxItem(saved, true)}
                >
                  <Send className="w-3.5 h-3.5" />
                  Send now
                </button>
              )}
              <button
                type="button"
                className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                title="Delete draft"
                onClick={() => void deleteSavedDraft(saved)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </MailDraggableDialog>
    </div>
  );
}

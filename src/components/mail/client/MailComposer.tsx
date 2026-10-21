import { type DragEvent as ReactDragEvent, type SetStateAction } from "react";
import { CheckCircle2, Image as ImageIcon, Loader2, Mail as MailIcon, Paperclip, Save, Send, X } from "lucide-react";
import { type MailDraft } from "../../../lib/mail";
import { toDateTimeLocal } from "../../../lib/mailOutbox";
import { identityLabel, swapSignature } from "../../../lib/mailIdentities";
import { RecipientField } from "../RecipientField";
import { RichMailEditor } from "../RichMailEditor";
import { type RecipientSuggestion } from "../../../lib/mailRecipients";
import { signatureToMailHtml } from "../../../lib/mailHtml";
import { droppedFilePaths, droppedFiles, isOsFileDrag, preventDefaultForOsFileDrag } from "../../../lib/osFileDrop";
import { type ComposeDraft, type ComposePromptState, type RecipientSearchState, type RecipientFieldKey } from "./types";
import { draftHasContent } from "./compose";
import { basename } from "./attachments";
import { MailDraggableDialog } from "./MailDraggableDialog";



export interface MailComposerProps {
  composeRootRef: import("react").RefObject<HTMLDivElement | null>;
  sending: boolean;
  setComposeDragActive: import("react").Dispatch<SetStateAction<boolean>>;
  addDraftAttachmentPaths: (paths: string[]) => Promise<void>;
  handleDropComposeFiles: (files: File[]) => Promise<void>;
  draft: ComposeDraft;
  setComposeOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setComposePrompt: import("react").Dispatch<SetStateAction<ComposePromptState | null>>;
  saveCurrentDraft: (mode?: "manual" | "auto") => Promise<MailDraft | null>;
  savingDraft: boolean;
  handleAddDraftAttachments: () => Promise<void>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
  attachProgress: { done: number; total: number; label: string; } | null;
  tabId: string;
  identityById: (id: string | null | undefined) => import("../../../types").MailIdentity;
  identities: import("../../../types").MailIdentity[];
  recipientSuggestionsFor: (field: RecipientFieldKey) => RecipientSuggestion[];
  defaultMailDomain: string | null;
  recipientSearch: RecipientSearchState;
  handleRecipientQueryChange: (field: RecipientFieldKey, nextQuery: string) => void;
  composeDragActive: boolean;
  handleInsertInlineImage: () => Promise<string | null>;
  handlePasteImages: (files: File[]) => Promise<string[]>;
  removeDraftAttachment: (index: number) => void;
  saveCurrentAsTemplate: () => Promise<void>;
  discardCurrentDraft: () => Promise<void>;
  setSendLaterAt: import("react").Dispatch<SetStateAction<string>>;
  setSendLaterOpen: import("react").Dispatch<SetStateAction<boolean>>;
  sendLaterOpen: boolean;
  sendLaterAt: string;
  handleSendLater: () => Promise<void>;
  handleSendDraft: (skipAttachReminder?: boolean) => Promise<void>;
}

export function MailComposer(viewProps: MailComposerProps) {
  const { addDraftAttachmentPaths, attachProgress, composeDragActive, composeRootRef, defaultMailDomain, discardCurrentDraft, draft, handleAddDraftAttachments, handleDropComposeFiles, handleInsertInlineImage, handlePasteImages, handleRecipientQueryChange, handleSendDraft, handleSendLater, identities, identityById, recipientSearch, recipientSuggestionsFor, removeDraftAttachment, saveCurrentAsTemplate, saveCurrentDraft, savingDraft, sendLaterAt, sendLaterOpen, sending, setComposeDragActive, setComposeOpen, setComposePrompt, setDraft, setSendLaterAt, setSendLaterOpen, tabId } = viewProps;
 return (<div
          ref={composeRootRef}
          className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-4"
          data-testid="mail-compose-dialog"
          onDragEnter={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending || !isOsFileDrag(event.dataTransfer)) return;
            preventDefaultForOsFileDrag(event);
            event.preventDefault();
            setComposeDragActive(true);
          }}
          onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending || !isOsFileDrag(event.dataTransfer)) return;
            preventDefaultForOsFileDrag(event);
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setComposeDragActive(true);
          }}
          onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!composeRootRef.current?.contains(event.relatedTarget as Node | null)) {
              setComposeDragActive(false);
            }
          }}
          onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending) return;
            if (!isOsFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            setComposeDragActive(false);
            const paths = droppedFilePaths(event.dataTransfer);
            if (paths.length > 0) {
              void addDraftAttachmentPaths(paths);
              return;
            }
            const files = droppedFiles(event.dataTransfer);
            if (files.length > 0) void handleDropComposeFiles(files);
          }}
        >
          <MailDraggableDialog
            title={draft.id ? "Edit draft" : draft.replyContext?.kind ? "Reply" : "New message"}
            icon={<MailIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="New message"
            minWidth={520}
            minHeight={360}
            className="w-[min(920px,calc(100vw-48px))] h-[min(760px,calc(100vh-72px))] max-w-[calc(100vw-48px)] max-h-[calc(100vh-72px)]"
            onClose={() => {
              setComposeOpen(false);
              setComposePrompt(null);
            }}
          >
            <div className="h-8 px-3 flex items-center gap-1 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] text-[12px]" data-testid="mail-compose-menu-bar">
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => void saveCurrentDraft("manual")} disabled={savingDraft || sending}>File</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => document.execCommand("undo")} disabled={sending}>Edit</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => void handleAddDraftAttachments()} disabled={sending}>Insert</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => setDraft((current) => ({ ...current, richFormatUsed: true }))} disabled={sending}>Format</button>
              <button type="button" className="taomni-btn h-6 px-2" disabled={sending}>Options</button>
              <button type="button" className="taomni-btn h-6 px-2" disabled={sending}>Tools</button>
              <span className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">
                {attachProgress
                  ? `${attachProgress.label} ${attachProgress.done}/${attachProgress.total}`
                  : savingDraft
                    ? "Saving draft..."
                    : draft.id
                      ? "Draft saved locally"
                      : "Auto draft"}
              </span>
            </div>
            {attachProgress && (
              <div
                className="px-3 py-1.5 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-2"
                data-testid="mail-compose-attach-progress"
              >
                {attachProgress.done < attachProgress.total
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                <span>
                  {attachProgress.label}
                  {" "}
                  ({attachProgress.done}/{attachProgress.total})
                </span>
                <div className="ml-auto h-1.5 w-32 rounded bg-[var(--taomni-divider)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--taomni-accent)] transition-all"
                    style={{ width: `${attachProgress.total ? Math.round((attachProgress.done / attachProgress.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}
            <div className="p-3 grid grid-cols-[56px_1fr] gap-2 text-[12px]">
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-from-${tabId}`}>From</label>
              <select
                id={`mail-from-${tabId}`}
                className="taomni-input h-7"
                data-testid="mail-compose-from"
                value={identityById(draft.identityId).id}
                disabled={sending || identities.length < 2}
                onChange={(event) => {
                  const next = identityById(event.target.value);
                  setDraft((current) => {
                    const previous = identityById(current.identityId);
                    return {
                      ...current,
                      identityId: next.id,
                      htmlBody: swapSignature(
                        current.htmlBody,
                        signatureToMailHtml(previous.signature),
                        signatureToMailHtml(next.signature),
                      ),
                    };
                  });
                }}
              >
                {identities.map((identity) => (
                  <option key={identity.id} value={identity.id}>{identityLabel(identity)}</option>
                ))}
              </select>
              <RecipientField
                id={`mail-to-${tabId}`}
                label="To"
                recipients={draft.to}
                suggestions={recipientSuggestionsFor("to")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "to" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-to"
                onChange={(to) => setDraft((current) => ({ ...current, to }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("to", nextQuery)}
              />
              <RecipientField
                id={`mail-cc-${tabId}`}
                label="Cc"
                recipients={draft.cc}
                suggestions={recipientSuggestionsFor("cc")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "cc" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-cc"
                onChange={(cc) => setDraft((current) => ({ ...current, cc }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("cc", nextQuery)}
              />
              <RecipientField
                id={`mail-bcc-${tabId}`}
                label="Bcc"
                recipients={draft.bcc}
                suggestions={recipientSuggestionsFor("bcc")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "bcc" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-bcc"
                onChange={(bcc) => setDraft((current) => ({ ...current, bcc }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("bcc", nextQuery)}
              />
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-subject-${tabId}`}>Subject</label>
              <input
                id={`mail-subject-${tabId}`}
                className="taomni-input h-7"
                data-testid="mail-compose-subject"
                value={draft.subject}
                onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
              />
            </div>
            <RichMailEditor
              html={draft.htmlBody}
              disabled={sending}
              dragActive={composeDragActive}
              onAttach={() => void handleAddDraftAttachments()}
              onInlineImage={() => handleInsertInlineImage()}
              onPasteImages={handlePasteImages}
              onDropFiles={(files) => void handleDropComposeFiles(files)}
              onRichFormatUsed={() => setDraft((current) => ({ ...current, richFormatUsed: true }))}
              onChange={(htmlBody, textBody) => setDraft((current) => ({ ...current, htmlBody, textBody }))}
            />
            <div
              className={`mx-3 mb-3 min-h-[40px] rounded border border-dashed px-2 py-2 ${
                composeDragActive
                  ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/10"
                  : "border-[var(--taomni-divider)]"
              }`}
              data-testid="mail-compose-attachments"
              data-drag-active={composeDragActive ? "true" : "false"}
            >
              {draft.attachments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {draft.attachments.map((attachment, index) => (
                    <span
                      key={`${attachment.path}-${index}`}
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-2 py-1 text-[11px] text-[var(--taomni-text-muted)] bg-[var(--taomni-sidebar-bg)]"
                      data-testid="mail-compose-attachment-chip"
                      title={attachment.path}
                    >
                      {attachment.inline ? <ImageIcon className="w-3 h-3" /> : <Paperclip className="w-3 h-3" />}
                      <span className="max-w-[280px] truncate">
                        {attachment.inline ? "Inline " : ""}{attachment.name || basename(attachment.path)}
                      </span>
                      <button
                        type="button"
                        className="ml-1 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                        aria-label={`Remove ${attachment.name || "attachment"}`}
                        onClick={() => removeDraftAttachment(index)}
                        disabled={sending}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5" />
                  Drop files here to attach, or use Attach / paste images into the editor
                </div>
              )}
            </div>
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 mr-auto" onClick={() => void handleAddDraftAttachments()} disabled={sending}>
                <Paperclip className="w-3.5 h-3.5" />
                Attach
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" data-testid="mail-compose-save-draft" onClick={() => void saveCurrentDraft("manual")} disabled={savingDraft || sending || !draftHasContent(draft)}>
                {savingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save draft
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-3 text-[12px]"
                data-testid="mail-compose-save-template"
                onClick={() => void saveCurrentAsTemplate()}
                disabled={savingDraft || sending || !draftHasContent(draft)}
                title="Save this message as a reusable template"
              >
                Save as template
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" data-testid="mail-compose-discard" onClick={() => void discardCurrentDraft()} disabled={sending}>
                Discard
              </button>
              <label className="inline-flex items-center gap-1 text-[12px] text-[var(--taomni-text-muted)]" title="Ask the recipient's client to send a read receipt">
                <input
                  type="checkbox"
                  checked={draft.readReceipt === true}
                  data-testid="mail-compose-read-receipt"
                  onChange={(event) => setDraft((current) => ({ ...current, readReceipt: event.target.checked }))}
                />
                Receipt
              </label>
              <div className="relative">
                <button
                  type="button"
                  className="taomni-btn h-7 px-3 text-[12px]"
                  data-testid="mail-compose-send-later"
                  disabled={sending}
                  onClick={() => {
                    setSendLaterAt((current) => current || toDateTimeLocal(Math.floor(Date.now() / 1000) + 3600));
                    setSendLaterOpen((open) => !open);
                  }}
                >
                  Send later
                </button>
                {sendLaterOpen && (
                  <div
                    className="absolute bottom-9 right-0 z-10 w-72 p-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg text-[12px] flex flex-col gap-2"
                    data-testid="mail-send-later-panel"
                  >
                    <label className="flex flex-col gap-1">
                      <span className="text-[var(--taomni-text-muted)]">Send at (empty = keep in Outbox)</span>
                      <input
                        type="datetime-local"
                        className="taomni-input"
                        value={sendLaterAt}
                        data-testid="mail-send-later-at"
                        onChange={(event) => setSendLaterAt(event.target.value)}
                      />
                    </label>
                    <span className="text-[11px] text-[var(--taomni-text-muted)]">
                      Scheduled mail only goes out while this account's tab is open.
                    </span>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="taomni-btn h-7 px-2" onClick={() => setSendLaterOpen(false)}>Cancel</button>
                      <button type="button" className="taomni-btn h-7 px-2" data-primary="true" data-testid="mail-send-later-confirm" onClick={() => void handleSendLater()}>
                        Queue
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5" data-primary="true" data-testid="mail-compose-send" onClick={() => void handleSendDraft()} disabled={sending}>
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Send
              </button>
            </div>
          </MailDraggableDialog>
        </div>);
}

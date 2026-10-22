import { type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Download, ExternalLink, Loader2, MessageSquareReply } from "lucide-react";
import { type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { MailMessageBodyView } from "../MailMessageBodyView";
import { mailHtmlHasRemoteImages } from "../../../lib/mailHtml";
import { messageKey, addressLabel, bodyMatchesMessage, formatFullDate, formatBytes } from "./messages";
import { ALL_ATTACHMENTS_INDEX } from "./attachments";
import { RemoteImagesBanner } from "./RemoteImagesBanner";


export interface CreateMailReaderRendererContext {
  bodyCache: Map<string, MailMessageBody>;
  body: MailMessageBody | null;
  messageAllowsRemote: (key: string | null | undefined) => boolean;
  bodyLoadingKey: string | null;
  showReaderMenu: (event: ReactMouseEvent, message: MailMessageHeader | null) => void;
  openReply: (target?: MailMessageHeader | null) => void;
  openReplyAll: (target?: MailMessageHeader | null) => void;
  openMessagePopup: (message: MailMessageHeader) => void;
  toggleRemoteForMessage: (key: string) => void;
  renderUnsubscribe: (message: MailMessageHeader) => import("react").JSX.Element | null;
  handleSaveAllAttachments: (message: MailMessageHeader, attachments: import("../../../lib/mail").MailAttachmentInfo[]) => Promise<void>;
  downloadingAttachmentIndex: number | null;
  handleOpenAttachment: (message: MailMessageHeader, attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => Promise<void>;
  handleAttachmentContextMenu: (event: ReactMouseEvent, message: MailMessageHeader, attachments: import("../../../lib/mail").MailAttachmentInfo[], attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => void;
  allowRemoteForMessage: (key: string) => void;
  setAllowRemoteAllInTab: import("react").Dispatch<SetStateAction<boolean>>;
  blockRemoteForMessage: (key: string) => void;
  preferDarkReader: boolean;
  mailFontSize: number;
  openComposeFromMailto: (href: string) => void;
}

export function createMailReaderRenderer(context: CreateMailReaderRendererContext) {
  const {
    bodyCache,
    body,
    messageAllowsRemote,
    bodyLoadingKey,
    showReaderMenu,
    openReply,
    openReplyAll,
    openMessagePopup,
    toggleRemoteForMessage,
    renderUnsubscribe,
    handleSaveAllAttachments,
    downloadingAttachmentIndex,
    handleOpenAttachment,
    handleAttachmentContextMenu,
    allowRemoteForMessage,
    setAllowRemoteAllInTab,
    blockRemoteForMessage,
    preferDarkReader,
    mailFontSize,
    openComposeFromMailto,
  } = context;
  const renderReaderSurface = (message: MailMessageHeader | null, popup = false) => {
    const currentBody = message
      ? bodyCache.get(messageKey(message)) ?? (bodyMatchesMessage(body, message) ? body : null)
      : null;
    const currentKey = message ? messageKey(message) : null;
    const currentHasRemoteImages = mailHtmlHasRemoteImages(currentBody?.html);
    const currentAllowsRemote = messageAllowsRemote(currentKey);
    const currentAttachments = currentBody?.attachments.length ? currentBody.attachments : message?.attachments ?? [];
    const loadingThisBody = !!message && bodyLoadingKey === messageKey(message);

    return (
      <main
        className="h-full min-w-0 flex flex-col"
        onContextMenu={(event) => showReaderMenu(event, message)}
      >
        <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
          <span className="text-[12px] font-semibold min-w-0 truncate">
            {message?.subject || "Message"}
          </span>
          {loadingThisBody && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReply(message)}
              disabled={!message}
              title="Reply"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply
            </button>
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReplyAll(message)}
              disabled={!message}
              title="Reply all"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply all
            </button>
            {!popup && (
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                onClick={() => message && openMessagePopup(message)}
                disabled={!message}
                title="Open message in popup window"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Popup
              </button>
            )}
          </div>
        </div>

        {!message ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
            Select a message
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 py-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <h2 className="text-[17px] font-semibold leading-6 mb-1 break-words">
                {message.subject || "(no subject)"}
              </h2>
              <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
                <span className="text-[var(--taomni-text-muted)]">From</span>
                <span className="truncate" title={addressLabel(message.from)}>{addressLabel(message.from) || "(unknown)"}</span>
                <span className="text-[var(--taomni-text-muted)]">To</span>
                <span className="truncate" title={message.to.map(addressLabel).join(", ")}>
                  {message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}
                </span>
                {message.cc.length > 0 && (
                  <>
                    <span className="text-[var(--taomni-text-muted)]">Cc</span>
                    <span className="truncate" title={message.cc.map(addressLabel).join(", ")}>
                      {message.cc.map(addressLabel).filter(Boolean).join(", ")}
                    </span>
                  </>
                )}
                <span className="text-[var(--taomni-text-muted)]">Date</span>
                <span>{formatFullDate(message.dateTs) || "(unknown)"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
                <span>{currentBody?.source === "cache" ? "cached body" : currentBody?.source === "remote" ? "remote body" : "header cached"}</span>
                {message.rawSize ? <span>{formatBytes(message.rawSize)}</span> : null}
                {currentHasRemoteImages && currentKey && (
                  <button
                    type="button"
                    className="taomni-btn h-5 px-2 text-[10px]"
                    data-testid="mail-remote-images-header-toggle"
                    onClick={() => toggleRemoteForMessage(currentKey)}
                  >
                    {currentAllowsRemote ? "Block remote images" : "Load remote images"}
                  </button>
                )}
                {renderUnsubscribe(message)}
              </div>
              {currentAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {currentAttachments.length > 1 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                      title="Save all attachments"
                      onClick={() => void handleSaveAllAttachments(message, currentAttachments)}
                      disabled={downloadingAttachmentIndex !== null}
                    >
                      {downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      <span>Save all</span>
                    </button>
                  )}
                  {currentAttachments.map((attachment, index) => {
                    const downloading = downloadingAttachmentIndex === index;
                    const savingAll = downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX;
                    const name = attachment.name || `attachment-${index + 1}`;
                    return (
                      <button
                        key={`${name}-${index}`}
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                        title={`Double-click to open ${name}; right-click to save`}
                        onDoubleClick={() => void handleOpenAttachment(message, attachment, index)}
                        onContextMenu={(event) => handleAttachmentContextMenu(event, message, currentAttachments, attachment, index)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          void handleOpenAttachment(message, attachment, index);
                        }}
                        disabled={downloading || savingAll}
                      >
                        {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                        <span className="max-w-[360px] truncate">{name}</span>
                        {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <RemoteImagesBanner
              visible={currentHasRemoteImages}
              allowRemoteImages={currentAllowsRemote}
              onAllowThisMessage={() => currentKey && allowRemoteForMessage(currentKey)}
              onAllowAllInTab={() => setAllowRemoteAllInTab(true)}
              onBlock={() => currentKey && blockRemoteForMessage(currentKey)}
            />

            <div className="p-3 sm:p-4">
              <MailMessageBodyView
                html={currentBody?.html}
                text={currentBody?.text}
                snippet={message.snippet}
                allowRemoteImages={currentAllowsRemote}
                preferDark={preferDarkReader}
                fontSize={mailFontSize}
                title={message.subject || "Message body"}
                loading={loadingThisBody && !currentBody}
                onMailtoLink={openComposeFromMailto}
              />
            </div>
          </div>
        )}
      </main>
    );
  };
  return { renderReaderSurface };
}

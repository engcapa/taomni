import { type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Panel } from "react-resizable-panels";
import { Bot, Download, ExternalLink, Loader2, MailOpen, MessageSquareReply, Sparkles } from "lucide-react";
import { type MailAttachmentInfo, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { MailMessageBodyView } from "../MailMessageBodyView";
import { type AiAction } from "./types";
import { messageKey, addressLabel, formatFullDate, formatBytes } from "./messages";
import { ALL_ATTACHMENTS_INDEX } from "./attachments";
import { RemoteImagesBanner } from "./RemoteImagesBanner";



export interface MailReaderPaneProps {
  showReaderMenu: (event: ReactMouseEvent, message: MailMessageHeader | null) => void;
  selectedMessage: MailMessageHeader | null;
  bodyLoadingKey: string | null;
  openReply: (target?: MailMessageHeader | null) => void;
  openReplyAll: (target?: MailMessageHeader | null) => void;
  openMessagePopup: (message: MailMessageHeader) => void;
  handleAiAction: (action: AiAction) => Promise<void>;
  info: import("../../../types").MailTabInfo;
  selectedBody: MailMessageBody | null;
  selectedHasRemoteImages: boolean;
  selectedMessageRemoteKey: string | null;
  toggleRemoteForMessage: (key: string) => void;
  selectedAllowsRemote: boolean;
  renderUnsubscribe: (message: MailMessageHeader) => import("react").JSX.Element | null;
  visibleAttachments: MailAttachmentInfo[];
  handleSaveAllAttachments: (message: MailMessageHeader, attachments: MailAttachmentInfo[]) => Promise<void>;
  downloadingAttachmentIndex: number | null;
  handleOpenAttachment: (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => Promise<void>;
  handleAttachmentContextMenu: (event: ReactMouseEvent, message: MailMessageHeader, attachments: MailAttachmentInfo[], attachment: MailAttachmentInfo, index: number) => void;
  renderInviteCard: (message: MailMessageHeader) => import("react").JSX.Element | null;
  renderReceiptBanner: (message: MailMessageHeader) => import("react").JSX.Element | null;
  allowRemoteForMessage: (key: string) => void;
  setAllowRemoteAllInTab: import("react").Dispatch<SetStateAction<boolean>>;
  blockRemoteForMessage: (key: string) => void;
  preferDarkReader: boolean;
  mailFontSize: number;
  openComposeFromMailto: (href: string) => void;
}

export function MailReaderPane(viewProps: MailReaderPaneProps) {
  const { allowRemoteForMessage, blockRemoteForMessage, bodyLoadingKey, downloadingAttachmentIndex, handleAiAction, handleAttachmentContextMenu, handleOpenAttachment, handleSaveAllAttachments, info, mailFontSize, openComposeFromMailto, openMessagePopup, openReply, openReplyAll, preferDarkReader, renderInviteCard, renderReceiptBanner, renderUnsubscribe, selectedAllowsRemote, selectedBody, selectedHasRemoteImages, selectedMessage, selectedMessageRemoteKey, setAllowRemoteAllInTab, showReaderMenu, toggleRemoteForMessage, visibleAttachments } = viewProps;
 return (<Panel id="reader" defaultSize="52%" minSize="25%" className="min-w-0">
            <main
              className="h-full min-w-0 flex flex-col"
              onContextMenu={(event) => showReaderMenu(event, selectedMessage)}
            >
              <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
                <span className="text-[12px] font-semibold min-w-0 truncate">
                  {selectedMessage?.subject || "Message"}
                </span>
                {selectedMessage && bodyLoadingKey === messageKey(selectedMessage) && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => openReply()}
                    disabled={!selectedMessage}
                    title="Reply"
                  >
                    <MessageSquareReply className="w-3.5 h-3.5" />
                    Reply
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => openReplyAll()}
                    disabled={!selectedMessage}
                    title="Reply all"
                  >
                    <MessageSquareReply className="w-3.5 h-3.5" />
                    Reply all
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => selectedMessage && openMessagePopup(selectedMessage)}
                    disabled={!selectedMessage}
                    title="Open message in popup window"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Popup
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("summarize")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Summarize with AI"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Summary
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("reply")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Draft reply with AI"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    Draft
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("tasks")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Extract tasks with AI"
                  >
                    <MailOpen className="w-3.5 h-3.5" />
                    Tasks
                  </button>
                </div>
              </div>

              {!selectedMessage ? (
                <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  Select a message
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="px-4 py-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
                    <h2 className="text-[17px] font-semibold leading-6 mb-1 break-words">
                      {selectedMessage.subject || "(no subject)"}
                    </h2>
                    <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
                      <span className="text-[var(--taomni-text-muted)]">From</span>
                      <span className="truncate" title={addressLabel(selectedMessage.from)}>{addressLabel(selectedMessage.from) || "(unknown)"}</span>
                      <span className="text-[var(--taomni-text-muted)]">To</span>
                      <span className="truncate" title={selectedMessage.to.map(addressLabel).join(", ")}>
                        {selectedMessage.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}
                      </span>
                      {selectedMessage.cc.length > 0 && (
                        <>
                          <span className="text-[var(--taomni-text-muted)]">Cc</span>
                          <span className="truncate" title={selectedMessage.cc.map(addressLabel).join(", ")}>
                            {selectedMessage.cc.map(addressLabel).filter(Boolean).join(", ")}
                          </span>
                        </>
                      )}
                      <span className="text-[var(--taomni-text-muted)]">Date</span>
                      <span>{formatFullDate(selectedMessage.dateTs) || "(unknown)"}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
                      <span>{selectedBody?.source === "cache" ? "cached body" : selectedBody?.source === "remote" ? "remote body" : "header cached"}</span>
                      {selectedMessage.rawSize ? <span>{formatBytes(selectedMessage.rawSize)}</span> : null}
                      {info.ai.enabled && <span>AI confirm {info.ai.skipBodyConfirm ? "skipped" : "required"}</span>}
                      {selectedHasRemoteImages && selectedMessageRemoteKey && (
                        <button
                          type="button"
                          className="taomni-btn h-5 px-2 text-[10px]"
                          data-testid="mail-remote-images-header-toggle"
                          onClick={() => toggleRemoteForMessage(selectedMessageRemoteKey)}
                        >
                          {selectedAllowsRemote ? "Block remote images" : "Load remote images"}
                        </button>
                      )}
                      {renderUnsubscribe(selectedMessage)}
                    </div>
                    {visibleAttachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {visibleAttachments.length > 1 && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                            title="Save all attachments"
                            onClick={() => void handleSaveAllAttachments(selectedMessage, visibleAttachments)}
                            disabled={downloadingAttachmentIndex !== null}
                          >
                            {downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                            <span>Save all</span>
                          </button>
                        )}
                        {visibleAttachments.map((attachment, index) => {
                          const downloading = downloadingAttachmentIndex === index;
                          const savingAll = downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX;
                          const name = attachment.name || `attachment-${index + 1}`;
                          return (
                            <button
                              key={`${name}-${index}`}
                              type="button"
                              className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                              title={`Double-click to open ${name}; right-click to save`}
                              onDoubleClick={() => void handleOpenAttachment(selectedMessage, attachment, index)}
                              onContextMenu={(event) => handleAttachmentContextMenu(event, selectedMessage, visibleAttachments, attachment, index)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                void handleOpenAttachment(selectedMessage, attachment, index);
                              }}
                              disabled={downloading || savingAll}
                            >
                              {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                              <span className="max-w-[260px] truncate">{name}</span>
                              {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  {renderInviteCard(selectedMessage)}
                  {renderReceiptBanner(selectedMessage)}

                  <RemoteImagesBanner
                    visible={selectedHasRemoteImages}
                    allowRemoteImages={selectedAllowsRemote}
                    onAllowThisMessage={() => selectedMessageRemoteKey && allowRemoteForMessage(selectedMessageRemoteKey)}
                    onAllowAllInTab={() => setAllowRemoteAllInTab(true)}
                    onBlock={() => selectedMessageRemoteKey && blockRemoteForMessage(selectedMessageRemoteKey)}
                  />

                  <div className="p-3 sm:p-4">
                    <MailMessageBodyView
                      html={selectedBody?.html}
                      text={selectedBody?.text}
                      snippet={selectedMessage.snippet}
                      allowRemoteImages={selectedAllowsRemote}
                      preferDark={preferDarkReader}
                      fontSize={mailFontSize}
                      title={selectedMessage.subject || "Message body"}
                      loading={!!selectedMessage && bodyLoadingKey === messageKey(selectedMessage) && !selectedBody}
                      onMailtoLink={openComposeFromMailto}
                    />
                  </div>
                </div>
              )}
            </main>
          </Panel>);
}

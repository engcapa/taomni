import { type SetStateAction, type UIEvent } from "react";
import { Panel } from "react-resizable-panels";
import { ChevronDown, Loader2, MessageSquareReply, Trash2 } from "lucide-react";
import { type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";
import { type MailThreadRow } from "../../../lib/mailThreads";
import { type MenuItem } from "../../ContextMenu";
import { type MailRowActions } from "./MailRowActions";
import { MAIL_THREAD_VIEW_STORAGE_KEY, messageKey } from "./messages";
import { MailListRow } from "./MailListRow";



export interface MailMessagesPaneProps {
  allFilteredMessagesChecked: boolean;
  filteredMessages: MailMessageHeader[];
  toggleFilteredMessagesChecked: (checked: boolean) => void;
  activeFolder: MailFolder;
  threadView: boolean;
  setThreadView: import("react").Dispatch<SetStateAction<boolean>>;
  messages: MailMessageHeader[];
  hasMoreMessages: boolean;
  loadingMessages: boolean;
  query: string;
  busyAction: boolean;
  checkedMessages: MailMessageHeader[];
  handleDeleteMessages: (targets: MailMessageHeader[]) => Promise<void>;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
  handleMessageListScroll: (event: UIEvent<HTMLDivElement>) => void;
  mailMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  messageListMenuItems: () => MenuItem[];
  quickFilterActive: boolean;
  listRows: MailThreadRow[];
  selectedMessageKey: string | null;
  checkedMessageKeys: Set<string>;
  selectedFolder: string;
  displayFolders: MailFolder[];
  rowActionsRef: import("react").RefObject<MailRowActions | null>;
  loadingMoreMessages: boolean;
  loadMoreMessages: () => Promise<void>;
}

export function MailMessagesPane(viewProps: MailMessagesPaneProps) {
  const { activeFolder, allFilteredMessagesChecked, busyAction, checkedMessageKeys, checkedMessages, displayFolders, filteredMessages, handleDeleteMessages, handleMessageListScroll, hasMoreMessages, listRows, loadMoreMessages, loadingMessages, loadingMoreMessages, mailMenu, messageListMenuItems, messages, query, quickFilterActive, rowActionsRef, selectedFolder, selectedMessageKey, setCheckedMessageKeys, setThreadView, threadView, toggleFilteredMessagesChecked } = viewProps;
 return (<Panel id="messages" defaultSize="34%" minSize="18%" maxSize="55%" className="min-w-0">
            <section className="h-full min-w-0 flex flex-col">
              <div className="h-8 shrink-0 px-3 flex items-center justify-between border-b border-[var(--taomni-divider)]">
                <div className="min-w-0 flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="taomni-checkbox shrink-0"
                    aria-label="Select all visible messages"
                    checked={allFilteredMessagesChecked}
                    disabled={filteredMessages.length === 0}
                    onChange={(event) => toggleFilteredMessagesChecked(event.target.checked)}
                  />
                  <span className="text-[12px] font-semibold truncate" title={activeFolder?.name}>{folderLabel(activeFolder)}</span>
                  <button
                    type="button"
                    className={`taomni-btn h-6 px-1.5 text-[11px] inline-flex items-center gap-1 ${threadView ? "text-[var(--taomni-accent)]" : ""}`}
                    data-testid="mail-thread-view-toggle"
                    aria-pressed={threadView}
                    title={threadView ? "Show messages unthreaded" : "Group messages into conversations"}
                    onClick={() => {
                      const next = !threadView;
                      setThreadView(next);
                      try {
                        window.localStorage.setItem(MAIL_THREAD_VIEW_STORAGE_KEY, String(next));
                      } catch {
                        // Per-viewer convenience only.
                      }
                    }}
                  >
                    <MessageSquareReply className="w-3 h-3" />
                    Threads
                  </button>
                </div>
                <span
                  className="text-[11px] text-[var(--taomni-text-muted)]"
                  data-testid="mail-message-count"
                  data-count={messages.length}
                  data-has-more={hasMoreMessages ? "true" : "false"}
                >
                  {loadingMessages ? "Loading" : `${filteredMessages.length}/${messages.length}${!query.trim() && hasMoreMessages ? "+" : ""}`}
                </span>
              </div>
              <div className="min-h-8 shrink-0 px-3 py-1 flex flex-wrap items-center gap-2 border-b border-[var(--taomni-divider)]">
                <button
                  type="button"
                  className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
                  data-testid="mail-delete-selected"
                  disabled={busyAction || checkedMessages.length === 0}
                  onClick={() => void handleDeleteMessages(checkedMessages)}
                  title="Delete selected messages; use checkboxes, Ctrl/Cmd-click or Shift-click to select"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete selected
                </button>
                <span className="text-[11px] text-[var(--taomni-text-muted)]" data-testid="mail-selection-count" aria-live="polite">
                  {checkedMessages.length} selected
                </span>
                {checkedMessages.length > 0 && (
                  <button type="button" className="taomni-btn h-6 px-1.5 text-[11px]" onClick={() => setCheckedMessageKeys(new Set())}>
                    Clear selection
                  </button>
                )}
              </div>
              <div
                className="flex-1 min-h-0 overflow-auto"
                data-testid="mail-message-list"
                onScroll={handleMessageListScroll}
                onContextMenu={(event) => mailMenu.show(event, messageListMenuItems())}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleFilteredMessagesChecked(true);
                  } else if (event.key === "Escape") {
                    setCheckedMessageKeys(new Set());
                  }
                }}
              >
                {loadingMessages && messages.length === 0 ? (
                  <div className="h-20 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading cached headers
                  </div>
                ) : filteredMessages.length === 0 ? (
                  <div className="h-28 flex items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
                    {query || quickFilterActive ? "No messages match the search or filter." : "No cached messages. Run Sync to refresh all folders."}
                  </div>
                ) : (
                  <>
                    {listRows.map((row) => (
                      <MailListRow
                        key={messageKey(row.message)}
                        {...row}
                        active={messageKey(row.message) === selectedMessageKey}
                        checked={checkedMessageKeys.has(messageKey(row.message))}
                        threadView={threadView}
                        selectedFolder={selectedFolder}
                        displayFolders={displayFolders}
                        actions={rowActionsRef}
                      />
                    ))}
                    {!query.trim() && !quickFilterActive && (hasMoreMessages || loadingMoreMessages) && (
                      <div className="p-2">
                        <button
                          type="button"
                          className="taomni-btn h-7 w-full inline-flex items-center justify-center gap-1.5 text-[12px]"
                          onClick={() => void loadMoreMessages()}
                          disabled={loadingMoreMessages}
                          data-testid="mail-load-more"
                        >
                          {loadingMoreMessages ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          Load older messages
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          </Panel>);
}

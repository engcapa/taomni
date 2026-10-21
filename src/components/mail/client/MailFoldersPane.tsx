import { type SetStateAction } from "react";
import { Panel, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { AlertTriangle, BookUser, CalendarDays, Filter as FilterIcon, ListChecks, Loader2 } from "lucide-react";
import { type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { type MailFilter } from "../../../lib/mailFilters";
import { type MailAddressBookEntry } from "../../../lib/mailContacts";
import { folderLabel, isSelectable } from "../../../lib/mailFolders";
import { type MenuItem } from "../../ContextMenu";
import { MAILBOX_EXPANDED_SIZE } from "./appearance";
import { folderIcon, MAIL_DRAG_TYPE, folderDepth } from "./folders";



export interface MailFoldersPaneProps {
  foldersPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  handleMailboxResize: (size: PanelSize) => void;
  mailboxCollapsed: boolean;
  loadingFolders: boolean;
  setSubscriptionsOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setContactDraft: import("react").Dispatch<SetStateAction<MailAddressBookEntry | null>>;
  setAddressBookOpen: import("react").Dispatch<SetStateAction<boolean>>;
  info: import("../../../types").MailTabInfo;
  setAgendaOpen: import("react").Dispatch<SetStateAction<boolean>>;
  filterErrors: string[];
  setFilterDraft: import("react").Dispatch<SetStateAction<MailFilter | null>>;
  setFiltersOpen: import("react").Dispatch<SetStateAction<boolean>>;
  treeFolders: MailFolder[];
  selectedFolder: string;
  dropFolder: string | null;
  draggedMessagesRef: import("react").RefObject<MailMessageHeader[]>;
  setDropFolder: import("react").Dispatch<SetStateAction<string | null>>;
  handleCopyMessages: (targets: MailMessageHeader[], target: string) => Promise<void>;
  handleMoveMessages: (targets: MailMessageHeader[], target: string) => Promise<void>;
  handleFolderSelect: (folder: MailFolder) => void;
  mailMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  folderMenuItems: (folder: MailFolder) => MenuItem[];
  cacheLine: string;
}

export function MailFoldersPane(viewProps: MailFoldersPaneProps) {
  const { cacheLine, draggedMessagesRef, dropFolder, filterErrors, folderMenuItems, foldersPanelRef, handleCopyMessages, handleFolderSelect, handleMailboxResize, handleMoveMessages, info, loadingFolders, mailMenu, mailboxCollapsed, selectedFolder, setAddressBookOpen, setAgendaOpen, setContactDraft, setDropFolder, setFilterDraft, setFiltersOpen, setSubscriptionsOpen, treeFolders } = viewProps;
 return (<Panel
            id="folders"
            panelRef={foldersPanelRef}
            defaultSize={`${MAILBOX_EXPANDED_SIZE}%`}
            minSize="0%"
            maxSize="35%"
            collapsible
            collapsedSize={0}
            className="min-w-0"
            onResize={handleMailboxResize}
          >
            {!mailboxCollapsed && (
              <aside className="h-full min-w-0 bg-[var(--taomni-sidebar-bg)] flex flex-col">
                <div className="h-8 shrink-0 flex items-center px-3 text-[12px] font-semibold border-b border-[var(--taomni-divider)]">
                  Mailbox
                  {loadingFolders && <Loader2 className="w-3.5 h-3.5 ml-auto animate-spin text-[var(--taomni-text-muted)]" />}
                  <button
                    type="button"
                    className={`${loadingFolders ? "ml-1" : "ml-auto"} h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]`}
                    title="Manage folder subscriptions"
                    aria-label="Manage folder subscriptions"
                    data-testid="mail-subscriptions-open"
                    onClick={() => setSubscriptionsOpen(true)}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                    title="Address book"
                    aria-label="Address book"
                    data-testid="mail-address-book-open"
                    onClick={() => {
                      setContactDraft(null);
                      setAddressBookOpen(true);
                    }}
                  >
                    <BookUser className="w-3.5 h-3.5" />
                  </button>
                  {info.caldav && (
                    <button
                      type="button"
                      className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                      title="Agenda"
                      aria-label="Agenda"
                      data-testid="mail-agenda-open"
                      onClick={() => setAgendaOpen(true)}
                    >
                      <CalendarDays className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                    title="Message filters"
                    aria-label="Message filters"
                    data-testid="mail-filters-open"
                    data-errors={filterErrors.length || undefined}
                    onClick={() => {
                      setFilterDraft(null);
                      setFiltersOpen(true);
                    }}
                  >
                    <FilterIcon className="w-3.5 h-3.5" />
                    {filterErrors.length > 0 && (
                      <AlertTriangle className="w-2.5 h-2.5 -ml-1 -mt-2 text-amber-500" data-testid="mail-filters-error-badge" />
                    )}
                  </button>
                </div>
                <div className="flex-1 min-h-0 py-1 overflow-auto">
                  {treeFolders.map((folder) => {
                    const active = folder.name === selectedFolder;
                    const label = folderLabel(folder);
                    return (
                      <button
                        key={folder.name}
                        type="button"
                        className={`w-full h-7 pr-3 flex items-center gap-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] ${active ? "bg-[var(--taomni-selected)] font-semibold" : ""} ${dropFolder === folder.name ? "outline outline-1 outline-[var(--taomni-accent)] -outline-offset-1" : ""}`}
                        style={{ paddingLeft: `${12 + Math.min(folderDepth(folder), 6) * 14}px` }}
                        data-active={active || undefined}
                        data-testid="mail-folder-row"
                        data-folder-name={folder.name}
                        data-unread={folder.unread ?? 0}
                        data-sync-error={folder.lastError ? "true" : undefined}
                        data-drop-target={dropFolder === folder.name ? "true" : undefined}
                        onDragOver={(event) => {
                          if (!event.dataTransfer.types.includes(MAIL_DRAG_TYPE) || !isSelectable(folder)) return;
                          const dragged = draggedMessagesRef.current;
                          if (dragged.length === 0 || dragged.every((m) => m.folder === folder.name)) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? "copy" : "move";
                          if (dropFolder !== folder.name) setDropFolder(folder.name);
                        }}
                        onDragLeave={() => {
                          if (dropFolder === folder.name) setDropFolder(null);
                        }}
                        onDrop={(event) => {
                          const dragged = draggedMessagesRef.current;
                          if (!event.dataTransfer.types.includes(MAIL_DRAG_TYPE) || dragged.length === 0) return;
                          event.preventDefault();
                          setDropFolder(null);
                          draggedMessagesRef.current = [];
                          // Move by default; Ctrl (Option on macOS) copies, like Thunderbird.
                          if (event.ctrlKey || event.altKey) void handleCopyMessages(dragged, folder.name);
                          else void handleMoveMessages(dragged, folder.name);
                        }}
                        onClick={() => handleFolderSelect(folder)}
                        onContextMenu={(event) => mailMenu.show(event, folderMenuItems(folder))}
                      >
                        <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                        <span className="min-w-0 flex-1 truncate" title={label === folder.name ? folder.name : `${label} (${folder.name})`}>{label}</span>
                        {folder.lastError && (
                          <span
                            className="text-[var(--taomni-warning,#d97706)]"
                            data-testid="mail-folder-sync-error"
                            title={`Sync failed: ${folder.lastError}`}
                            aria-label={`Sync failed: ${folder.lastError}`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {folder.unread !== null && folder.unread !== undefined && folder.unread > 0 && (
                          <span className="text-[11px] text-[var(--taomni-accent)]">{folder.unread}</span>
                        )}
                        {folder.total !== null && folder.total !== undefined && (
                          <span className="text-[11px] text-[var(--taomni-text-muted)]">{folder.total}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="shrink-0 border-t border-[var(--taomni-divider)] px-3 py-2 text-[11px] text-[var(--taomni-text-muted)] leading-5">
                  <div className="truncate" title={`${info.imap.host}:${info.imap.port}`}>
                    {info.incoming === "pop3" ? "POP3" : "IMAP"} {info.imap.host}:{info.imap.port}
                  </div>
                  <div className="truncate" title={`${info.smtp.host}:${info.smtp.port}`}>
                    SMTP {info.smtp.host}:{info.smtp.port}
                  </div>
                  <div className="truncate" title={cacheLine}>{cacheLine}</div>
                </div>
              </aside>
            )}
          </Panel>);
}

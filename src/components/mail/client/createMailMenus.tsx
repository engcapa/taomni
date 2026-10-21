import {
  Archive,
  Ban,
  BookUser,
  CheckCircle2,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Filter as FilterIcon,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSymlink,
  FolderX,
  Forward,
  ImageOff,
  Inbox,
  Link as LinkIcon,
  Mail as MailIcon,
  MailOpen,
  MessageSquareReply,
  PenLine,
  Printer,
  RefreshCw,
  Save,
  Search,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { type MailFolder, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { folderLabel, isSelectable } from "../../../lib/mailFolders";
import { MAIL_TAGS, messageTags } from "../../../lib/mailTags";
import { type MenuItem } from "../../ContextMenu";
import { folderIcon, folderMatchesSpecial, isUnread } from "./folders";
import { addressLabel, bodyMatchesMessage, dedupeMessages, isFlagged, messageKey } from "./messages";
import { createMailMutations } from "./mutations";
import { useMailComposer } from "./useMailComposer";
import { useMailMessageTabs } from "./useMailMessageTabs";
import { useMailSearch } from "./useMailSearch";
import { useMailSelection } from "./useMailSelection";
import { useMailSynchronization } from "./useMailSynchronization";

export interface CreateMailMenusContext {
  displayFolders: MailFolder[];
  selectionOwner: ReturnType<typeof useMailSelection>;
  messageTabsOwner: ReturnType<typeof useMailMessageTabs>;
  composerOwner: ReturnType<typeof useMailComposer>;
  markingRead: boolean;
  busyAction: boolean;
  handleMarkSelectedRead: () => Promise<void>;
  handleMarkSingleRead: (message: MailMessageHeader) => Promise<void>;
  mutationOwner: ReturnType<typeof createMailMutations>;
  handleMarkFolderRead: (folderName?: string) => Promise<void>;
  handleSaveEml: (message?: MailMessageHeader | null) => Promise<void>;
  handleViewSource: (message?: MailMessageHeader | null) => Promise<void>;
  handlePrintMessage: (message?: MailMessageHeader | null) => void;
  copyText: (label: string, value: string | null | undefined) => void;
  info: import("../../../types").MailTabInfo;
  handleFolderSelect: (folder: MailFolder) => void;
  handleSearchInFolder: (folder: MailFolder) => void;
  syncOwner: ReturnType<typeof useMailSynchronization>;
  handleCreateFolder: (parent?: MailFolder) => Promise<void>;
  handleRenameFolder: (folder: MailFolder) => Promise<void>;
  handleExportMbox: (folder: MailFolder) => Promise<void>;
  handleImportMessages: (folder: MailFolder) => Promise<void>;
  handleEmptyFolder: (folder: MailFolder) => Promise<void>;
  handleDeleteFolder: (folder: MailFolder) => Promise<void>;
  activeFolder: MailFolder;
  searchOwner: ReturnType<typeof useMailSearch>;
  body: MailMessageBody | null;
  openExternalUrl: (url: string) => Promise<void>;
  messageAllowsRemote: (key: string | null | undefined) => boolean;
  toggleRemoteForMessage: (key: string) => void;
  mailMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
}

export function createMailMenus(context: CreateMailMenusContext) {
  const {
    displayFolders,
    selectionOwner,
    messageTabsOwner,
    composerOwner,
    markingRead,
    busyAction,
    handleMarkSelectedRead,
    handleMarkSingleRead,
    mutationOwner,
    handleMarkFolderRead,
    handleSaveEml,
    handleViewSource,
    handlePrintMessage,
    copyText,
    info,
    handleFolderSelect,
    handleSearchInFolder,
    syncOwner,
    handleCreateFolder,
    handleRenameFolder,
    handleExportMbox,
    handleImportMessages,
    handleEmptyFolder,
    handleDeleteFolder,
    searchOwner,
    body,
    openExternalUrl,
    messageAllowsRemote,
    toggleRemoteForMessage,
    mailMenu,
    activeFolder,
  } = context;

  const folderTargetChildren = (
    targets: MailMessageHeader[],
    action: (targets: MailMessageHeader[], target: string) => void,
  ): MenuItem[] => {
    const sources = new Set(targets.map((message) => message.folder));
    const options = displayFolders.filter(
      (folder) => !(sources.size === 1 && sources.has(folder.name)),
    );
    if (options.length === 0) return [{ label: "No other folders", disabled: true }];
    return options.map((folder) => ({
      label: folderLabel(folder),
      icon: folderIcon(folder),
      onClick: () => action(targets, folder.name),
    }));
  };

  const messageMenuItems = (message: MailMessageHeader): MenuItem[] => {
    const targets = selectionOwner.checkedMessageKeys.has(messageKey(message)) && selectionOwner.checkedMessages.length > 0
      ? selectionOwner.checkedMessages
      : [message];
    const count = dedupeMessages(targets).length;
    const suffix = count > 1 ? ` (${count})` : "";
    const many = count > 1;
    const allFlagged = targets.every(isFlagged);
    const anyUnread = targets.some(isUnread);
    const allUnread = targets.every(isUnread);
    return [
      { label: "Open", icon: <MailOpen className="w-3.5 h-3.5" />, onClick: () => messageTabsOwner.selectMessage(message, "mailbox") },
      { label: "Open in mail tab", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => messageTabsOwner.openMessageTab(message) },
      { label: "Open in popup window", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => messageTabsOwner.openMessagePopup(message) },
      { label: "", separator: true },
      { label: "Reply", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => composerOwner.openReply(message) },
      { label: "Reply all", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => composerOwner.openReplyAll(message) },
      { label: "Forward", icon: <Forward className="w-3.5 h-3.5" />, onClick: () => composerOwner.openForward(message) },
      { label: "", separator: true },
      {
        label: `Mark as read${suffix}`,
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        disabled: !anyUnread || markingRead || busyAction,
        onClick: () => void (many ? handleMarkSelectedRead() : handleMarkSingleRead(message)),
      },
      {
        label: `Mark as unread${suffix}`,
        icon: <MailIcon className="w-3.5 h-3.5" />,
        disabled: allUnread || busyAction,
        onClick: () => void mutationOwner.handleMarkUnread(targets),
      },
      {
        label: allFlagged ? `Remove star${suffix}` : `Add star${suffix}`,
        icon: <Star className="w-3.5 h-3.5" />,
        disabled: busyAction,
        onClick: () => void mutationOwner.handleToggleFlagged(targets),
      },
      {
        label: `Tag${suffix}`,
        icon: <Tag className="w-3.5 h-3.5" />,
        testId: "mail-menu-tag",
        openOnClick: true,
        children: [
          ...MAIL_TAGS.map((tag) => ({
            label: tag.label,
            testId: `mail-menu-tag-${tag.keyword.replace("$", "")}`,
            checked: targets.every((target) => messageTags(target).some((entry) => entry.keyword === tag.keyword)),
            icon: <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tag.color }} />,
            disabled: busyAction,
            onClick: () => void mutationOwner.handleToggleKeyword(targets, tag.keyword, tag.label),
          })),
          { label: "", separator: true },
          { label: "Remove all tags", disabled: busyAction, onClick: () => void mutationOwner.handleClearTags(targets) },
        ],
      },
      { label: "Mark folder read", icon: <MailOpen className="w-3.5 h-3.5" />, disabled: markingRead, onClick: () => void handleMarkFolderRead(message.folder) },
      { label: "", separator: true },
      { label: `Archive${suffix}`, icon: <Archive className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void mutationOwner.handleArchiveMessages(targets) },
      { label: `Move to${suffix}`, icon: <FolderInput className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void mutationOwner.handleMoveMessages(t, folder)) },
      { label: `Copy to${suffix}`, icon: <FolderSymlink className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void mutationOwner.handleCopyMessages(t, folder)) },
      { label: `Mark as junk${suffix}`, icon: <Ban className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void mutationOwner.handleJunkMessages(targets) },
      { label: `Not junk${suffix}`, icon: <Inbox className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void mutationOwner.handleNotJunkMessages(targets) },
      { label: `Delete${suffix}`, icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, disabled: busyAction, onClick: () => void mutationOwner.handleDeleteMessages(targets) },
      { label: "", separator: true },
      { label: "Create filter from message…", icon: <FilterIcon className="w-3.5 h-3.5" />, testId: "mail-menu-create-filter", onClick: () => mutationOwner.openFilterFromMessage(message) },
      { label: "Add sender to address book…", icon: <BookUser className="w-3.5 h-3.5" />, testId: "mail-menu-add-contact", disabled: !message.from?.address, onClick: () => mutationOwner.openContactFromMessage(message) },
      { label: "Save as .eml", icon: <Save className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleSaveEml(message) },
      { label: "View source", icon: <Code className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleViewSource(message) },
      { label: "Print", icon: <Printer className="w-3.5 h-3.5" />, onClick: () => handlePrintMessage(message) },
      { label: "", separator: true },
      { label: "Copy subject", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => copyText("subject", message.subject || "(no subject)") },
      { label: "Copy sender", icon: <MailIcon className="w-3.5 h-3.5" />, onClick: () => copyText("sender", addressLabel(message.from)) },
      { label: "Copy recipients", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("recipients", message.to.map(addressLabel).filter(Boolean).join(", ")) },
    ];
  };

  const folderMenuItems = (folder: MailFolder): MenuItem[] => {
    const isTrashLike = folderMatchesSpecial(folder, "trash", info.specialFolders)
      || folderMatchesSpecial(folder, "junk", info.specialFolders);
    return [
      { label: "Open folder", icon: folderIcon(folder), onClick: () => handleFolderSelect(folder) },
      { label: "Search in this folder", icon: <Search className="w-3.5 h-3.5" />, onClick: () => handleSearchInFolder(folder) },
      {
        label: "Sync all folders",
        icon: <RefreshCw className="w-3.5 h-3.5" />,
        disabled: syncOwner.syncing,
        onClick: () => void syncOwner.syncAllFolders(false, { limit: syncOwner.batchSize, includeBodies: false, indicator: "sync" }),
      },
      {
        label: "Mark folder read",
        icon: <MailOpen className="w-3.5 h-3.5" />,
        disabled: markingRead || (folder.unread ?? 0) === 0,
        onClick: () => void handleMarkFolderRead(folder.name),
      },
      { label: "", separator: true },
      { label: "New subfolder…", icon: <FolderPlus className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleCreateFolder(folder) },
      { label: "Rename folder…", icon: <PenLine className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleRenameFolder(folder) },
      { label: "Export as mbox…", icon: <Download className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleExportMbox(folder) },
      { label: "Import messages (mbox/.eml)…", icon: <FolderInput className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleImportMessages(folder) },
      {
        label: isTrashLike ? "Empty folder" : "Delete folder",
        icon: isTrashLike ? <Trash2 className="w-3.5 h-3.5" /> : <FolderX className="w-3.5 h-3.5" />,
        danger: true,
        disabled: busyAction,
        onClick: () => void (isTrashLike ? handleEmptyFolder(folder) : handleDeleteFolder(folder)),
      },
      { label: "", separator: true },
      { label: "Copy folder name", icon: <Folder className="w-3.5 h-3.5" />, onClick: () => copyText("folder name", folder.name) },
    ];
  };

  const messageListMenuItems = (): MenuItem[] => [
    {
      label: "Sync all folders",
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      disabled: syncOwner.syncing,
      onClick: () => void syncOwner.syncAllFolders(false, {
        limit: syncOwner.batchSize,
        includeBodies: false,
        indicator: "sync",
      }),
    },
    {
      label: "Mark folder read",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      disabled: markingRead || Math.max(activeFolder?.unread ?? 0, selectionOwner.visibleUnreadCount) === 0,
      onClick: () => void handleMarkFolderRead(),
    },
    {
      label: selectionOwner.allFilteredMessagesChecked ? "Clear visible selection" : "Select visible messages",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      disabled: searchOwner.filteredMessages.length === 0,
      onClick: () => selectionOwner.toggleFilteredMessagesChecked(!selectionOwner.allFilteredMessagesChecked),
    },
  ];

  const showReaderMenu = (event: ReactMouseEvent, message: MailMessageHeader | null) => {
    const targetEl = event.target as HTMLElement | null;
    const anchor = targetEl?.closest("a") as HTMLAnchorElement | null;
    const image = (targetEl?.tagName === "IMG" ? targetEl : targetEl?.closest("img")) as HTMLImageElement | null;
    const selection = typeof window !== "undefined" ? (window.getSelection()?.toString().trim() ?? "") : "";
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const items: MenuItem[] = [];
    if (selection) {
      items.push({ label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("selection", selection) });
    }
    if (anchor?.href) {
      const href = anchor.href;
      items.push({ label: "Copy link address", icon: <LinkIcon className="w-3.5 h-3.5" />, onClick: () => copyText("link", href) });
      items.push({ label: "Open link in browser", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => void openExternalUrl(href) });
    }
    if (image) {
      const src = image.getAttribute("src") || image.src;
      if (src) items.push({ label: "Copy image address", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("image address", src) });
    }
    if (currentBody?.html && message) {
      const key = messageKey(message);
      items.push({
        label: messageAllowsRemote(key) ? "Block remote images" : "Load remote images",
        icon: <ImageOff className="w-3.5 h-3.5" />,
        onClick: () => toggleRemoteForMessage(key),
      });
    }
    if (items.length > 0) items.push({ label: "", separator: true });
    items.push(...(message ? messageMenuItems(message) : messageListMenuItems()));
    mailMenu.show(event, items);
  };
  return { showReaderMenu, messageMenuItems, folderMenuItems, messageListMenuItems };
}

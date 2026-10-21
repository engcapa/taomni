import { MailMutationSession } from "../../../lib/mailMutations";
import { type SetStateAction } from "react";
import { mailCreateFolder, mailDeleteFolder, mailDeleteMessages, mailRenameFolder, type MailFolder, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";
import { isUnread } from "./folders";


export interface CreateFolderActionsContext {
  runMailAction: (action: () => Promise<void>, retry?: boolean) => Promise<void>;
  textInputDialog: { promptText: (options: import("../../sidebar/ConfirmDialog").TextInputDialogOptions) => Promise<string | null>; render: import("react").ReactNode; };
  info: import("../../../types").MailTabInfo;
  loadCachedFolders: () => Promise<void>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  selectedFolder: string;
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
  confirmDialog: { confirm: (options: import("../../sidebar/ConfirmDialog").ConfirmDialogOptions) => Promise<boolean>; render: import("react").ReactNode; };
  setSelectedMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  setBody: import("react").Dispatch<SetStateAction<MailMessageBody | null>>;
  mutationSessionRef: import("react").RefObject<MailMutationSession>;
  removeMessagesLocally: (folder: string, uids: number[], unreadRemoved: number) => void;
  messages: MailMessageHeader[];
  reportMutationProgress: (completed: number, total: number) => void;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
}

export function createFolderActions(context: CreateFolderActionsContext) {
  const {
    runMailAction,
    textInputDialog,
    info,
    loadCachedFolders,
    setStatus,
    selectedFolder,
    updateSelectedFolder,
    confirmDialog,
    setSelectedMessageKey,
    setBody,
    mutationSessionRef,
    removeMessagesLocally,
    messages,
    reportMutationProgress,
    setMessages,
    setCheckedMessageKeys,
    setFolders,
  } = context;

  const handleCreateFolder = (parent?: MailFolder) => runMailAction(async () => {
    const name = await textInputDialog.promptText({
      title: parent ? `New subfolder in ${folderLabel(parent)}` : "New folder",
      label: "Folder name",
      placeholder: "Folder name",
    });
    if (!name || !name.trim()) return;
    const delimiter = parent?.delimiter || "/";
    const fullName = parent ? `${parent.name}${delimiter}${name.trim()}` : name.trim();
    await mailCreateFolder(info, fullName);
    await loadCachedFolders();
    setStatus(`Created folder ${name.trim()}`);
  });

  const handleRenameFolder = (folder: MailFolder) => runMailAction(async () => {
    const label = folderLabel(folder);
    const next = await textInputDialog.promptText({
      title: `Rename ${label}`,
      label: "New folder name",
      initialValue: label,
    });
    const trimmed = next?.trim();
    if (!trimmed || trimmed === label) return;
    const delimiter = folder.delimiter || "/";
    const idx = folder.name.lastIndexOf(delimiter);
    const parentPath = idx >= 0 ? folder.name.slice(0, idx + delimiter.length) : "";
    const target = `${parentPath}${trimmed}`;
    await mailRenameFolder(info, folder.name, target);
    if (selectedFolder === folder.name) updateSelectedFolder(target);
    await loadCachedFolders();
    setStatus(`Renamed folder to ${trimmed}`);
  });

  const handleDeleteFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Delete folder",
      message: `Delete folder "${folderLabel(folder)}" and its cached messages? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    await mailDeleteFolder(info, folder.name);
    if (selectedFolder === folder.name) {
      setSelectedMessageKey(null);
      setBody(null);
    }
    await loadCachedFolders();
    setStatus(`Deleted folder ${folderLabel(folder)}`);
  });

  const handleEmptyFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Empty folder",
      message: `Permanently delete all messages in "${folderLabel(folder)}"? This cannot be undone.`,
      confirmLabel: "Empty",
      danger: true,
    });
    if (!confirmed) return;
    const deleted = await mutationSessionRef.current.execute(JSON.stringify(["empty", folder.name]), [],
      (id) => mailDeleteMessages(info, folder.name, [], true, id),
      (done) => removeMessagesLocally(folder.name, done, messages.filter((m) => m.folder === folder.name && done.includes(m.uid) && isUnread(m)).length),
      reportMutationProgress);
    if (selectedFolder === folder.name) {
      setMessages([]);
      setSelectedMessageKey(null);
      setBody(null);
      setCheckedMessageKeys(new Set());
    }
    setFolders((current) => current.map((entry) => (
      entry.name === folder.name
        ? { ...entry, total: 0, unread: 0, updatedAt: Math.floor(Date.now() / 1000) }
        : entry
    )));
    setStatus(`Emptied ${deleted} message${deleted === 1 ? "" : "s"} from ${folderLabel(folder)}`);
  });
  return { handleCreateFolder, handleRenameFolder, handleEmptyFolder, handleDeleteFolder };
}

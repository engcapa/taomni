import { type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Download, ExternalLink } from "lucide-react";
import { mailDownloadAttachment, type MailAttachmentInfo, type MailMessageHeader } from "../../../lib/mail";
import { openTemporaryFile } from "../../../lib/fileOpenTemp";
import { getLocale } from "../../../lib/i18n";
import { type MenuItem } from "../../ContextMenu";
import { mailClientErrorMessage } from "./messages";
import { suggestedAttachmentName, ALL_ATTACHMENTS_INDEX, uniqueAttachmentName, joinLocalPath } from "./attachments";


export interface CreateAttachmentActionsContext {
  setDownloadingAttachmentIndex: import("react").Dispatch<SetStateAction<number | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  downloadingAttachmentIndex: number | null;
  attachmentMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
}

export function createAttachmentActions(context: CreateAttachmentActionsContext) {
  const { setDownloadingAttachmentIndex, setError, setStatus, info, downloadingAttachmentIndex, attachmentMenu } = context;

  const handleDownloadAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      const targetPath = await save({
        title: "Save attachment",
        defaultPath,
      });
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        setStatus("Attachment save cancelled");
        return;
      }
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath, attachment.section);
      setStatus(`Saved attachment to ${result.path}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleOpenAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number, mode?: "taomni" | "system") => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      await openTemporaryFile({
        key: JSON.stringify(["mail", info.sessionId, message.folder, message.uid, attachment.section, index]),
        fileName: defaultPath,
        source: "mail-attachment",
        readOnlyReason: getLocale().startsWith("zh") ? "邮件附件 · 只读副本" : "Mail attachment · read-only copy",
        download: async (path) => { await mailDownloadAttachment(info, message.folder, message.uid, index, path, attachment.section); },
      }, { context: "mail-attachment", mode });
      setStatus(`Opened attachment ${defaultPath}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleSaveAllAttachments = async (message: MailMessageHeader, attachments: MailAttachmentInfo[]) => {
    if (attachments.length === 0) return;
    setDownloadingAttachmentIndex(ALL_ATTACHMENTS_INDEX);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const targetDir = await open({
        title: "Save all attachments",
        directory: true,
        multiple: false,
      });
      if (typeof targetDir !== "string" || !targetDir.trim()) {
        setStatus("Save all attachments cancelled");
        return;
      }
      const usedNames = new Set<string>();
      let saved = 0;
      for (const [index, attachment] of attachments.entries()) {
        const fileName = uniqueAttachmentName(
          suggestedAttachmentName(attachment, index, message.subject),
          usedNames,
        );
        await mailDownloadAttachment(info, message.folder, message.uid, index, joinLocalPath(targetDir, fileName), attachment.section);
        saved += 1;
      }
      setStatus(`Saved ${saved} attachment${saved === 1 ? "" : "s"} to ${targetDir}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const attachmentMenuItems = (
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ): MenuItem[] => {
    const busy = downloadingAttachmentIndex !== null;
    const items: MenuItem[] = [
      {
        label: getLocale().startsWith("zh") ? "在 Taomni 中预览" : "Preview in Taomni",
        testId: "mail-attachment-preview",
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleOpenAttachment(message, attachment, index, "taomni"),
      },
      {
        label: getLocale().startsWith("zh") ? "系统应用" : "System app",
        testId: "mail-attachment-system",
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleOpenAttachment(message, attachment, index, "system"),
      },
      {
        label: "Save attachment as...",
        icon: <Download className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleDownloadAttachment(message, attachment, index),
      },
    ];
    if (attachments.length > 1) {
      items.push(
        { label: "", separator: true },
        {
          label: "Save all attachments...",
          icon: <Download className="w-3.5 h-3.5" />,
          disabled: busy,
          onClick: () => void handleSaveAllAttachments(message, attachments),
        },
      );
    }
    return items;
  };

  const handleAttachmentContextMenu = (
    event: ReactMouseEvent,
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ) => {
    attachmentMenu.show(event, attachmentMenuItems(message, attachments, attachment, index));
  };
  return { handleDownloadAttachment, handleOpenAttachment, handleSaveAllAttachments, handleAttachmentContextMenu };
}

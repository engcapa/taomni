import { Terminal as TerminalIcon, FileText, Image as ImageIcon, Server, X } from "lucide-react";
import type { ReactElement } from "react";
import type { AttachmentRef } from "../../lib/chat/composerRefs";
import { formatAttachmentBytes, type ChatAttachment } from "../../lib/chat/attachments";
import { useT, type TranslateFn } from "../../lib/i18n";

interface AttachmentChipProps {
  /**
   * The parsed `@…` reference. Named `attachment` (not `ref`) because `ref`
   * is a reserved React prop — React 18 strips it before the component
   * receives it, leaving the body to crash on `ref.kind`.
   */
  attachment: AttachmentRef | ChatAttachment;
  onRemove?: () => void;
}

/**
 * Compact display chip for an `@terminal` / `@file` / `@session` reference.
 * Used by the Composer to show resolved attachments before sending, and by
 * MessageBubble to render references attached to past messages.
 */
export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const t = useT();
  const { icon, label } = describe(attachment, t);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[10px] text-[var(--taomni-text-muted)]"
      title={label}
      data-testid="attachment-chip"
    >
      {icon}
      <span className="truncate max-w-[120px]">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={t("attachment.remove")}
          className="hover:text-red-400 transition-colors"
          onClick={onRemove}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

function describe(attachment: AttachmentRef | ChatAttachment, t: TranslateFn): { icon: ReactElement; label: string } {
  if (attachment.kind === "terminal") {
    return {
      icon: <TerminalIcon className="w-2.5 h-2.5" />,
      label: t("attachment.terminalLabel", { lines: attachment.lines }),
    };
  }
  if ("size" in attachment) {
    return {
      icon: attachment.kind === "image" ? <ImageIcon className="w-2.5 h-2.5" /> : <FileText className="w-2.5 h-2.5" />,
      label: `${attachment.name} (${formatAttachmentBytes(attachment.size)})`,
    };
  }
  if (attachment.kind === "file") {
    return {
      icon: <FileText className="w-2.5 h-2.5" />,
      label: attachment.path,
    };
  }
  return {
    icon: <Server className="w-2.5 h-2.5" />,
    label: t("attachment.sessionLabel", { query: attachment.query }),
  };
}

import { Terminal as TerminalIcon, FileText, Server, X } from "lucide-react";
import type { AttachmentRef } from "../../lib/chat/composerRefs";

interface AttachmentChipProps {
  ref: AttachmentRef;
  onRemove?: () => void;
}

/**
 * Compact display chip for an `@terminal` / `@file` / `@session` reference.
 * Used by the Composer to show resolved attachments before sending, and by
 * MessageBubble to render references attached to past messages.
 */
export function AttachmentChip({ ref, onRemove }: AttachmentChipProps) {
  const { icon, label } = describe(ref);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--moba-divider)] bg-[var(--moba-bg)] text-[10px] text-[var(--moba-text-muted)]"
      title={label}
      data-testid="attachment-chip"
    >
      {icon}
      <span className="truncate max-w-[120px]">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove attachment"
          className="hover:text-red-400 transition-colors"
          onClick={onRemove}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

function describe(ref: AttachmentRef): { icon: JSX.Element; label: string } {
  if (ref.kind === "terminal") {
    return {
      icon: <TerminalIcon className="w-2.5 h-2.5" />,
      label: `terminal: last-${ref.lines}`,
    };
  }
  if (ref.kind === "file") {
    return {
      icon: <FileText className="w-2.5 h-2.5" />,
      label: ref.path,
    };
  }
  return {
    icon: <Server className="w-2.5 h-2.5" />,
    label: `session: ${ref.query}`,
  };
}

import { Keyboard, X } from "lucide-react";

interface KeymapMigrationNoticeProps {
  onOpenKeymap: () => void;
  onDismiss: () => void;
}

/**
 * One-time IDEA-style balloon (bottom-right) explaining the ED-PARITY-013
 * default-binding migration to profiles that used the old keys (DEC-013-06).
 */
export function KeymapMigrationNotice({ onOpenKeymap, onDismiss }: KeymapMigrationNoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="keymap-migration-notice"
      className="pointer-events-auto absolute bottom-8 right-3 z-30 w-[340px] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] p-3 text-[11px] text-[var(--taomni-code-text)] shadow-lg"
    >
      <div className="flex items-start gap-2">
        <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Keymap now follows IntelliJ IDEA</div>
          <p className="mt-1 text-[var(--taomni-code-muted)]">
            F12 jumps to the last tool window (Go to Declaration stays on Ctrl+B) and Ctrl+Alt+S opens
            Settings. Choose the “Taomni Classic” scheme in Keymap Settings to keep the previous keys.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              data-testid="keymap-migration-open"
              className="text-[var(--taomni-code-accent,#4b9edd)] hover:underline"
              onClick={onOpenKeymap}
            >
              Open Keymap Settings
            </button>
            <button
              type="button"
              data-testid="keymap-migration-dismiss"
              className="text-[var(--taomni-code-muted)] hover:underline"
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close keymap notice"
          className="rounded p-0.5 hover:bg-[var(--taomni-code-hover)]"
          onClick={onDismiss}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

import { AlertTriangle } from "lucide-react";
import { type ComposePromptState } from "./types";


export function MailComposePrompt({
  prompt,
  onClose,
  onAttach,
  onSendAnyway,
}: {
  prompt: ComposePromptState;
  onClose: () => void;
  onAttach: () => void;
  onSendAnyway: () => void;
}) {
  const attachmentPrompt = prompt.kind === "attachment";
  return (
    <div
      className="fixed inset-0 z-[960] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={prompt.title}
      data-testid={attachmentPrompt ? "mail-attach-reminder" : "mail-compose-error-dialog"}
      onClick={onClose}
    >
      <div
        className="w-[min(460px,calc(100vw-32px))] rounded-md border p-4 shadow-2xl"
        style={{ background: "var(--taomni-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${attachmentPrompt ? "text-amber-500" : "text-red-500"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{prompt.title}</div>
            <div className="mt-2 whitespace-pre-line text-[12px]" data-testid="mail-compose-prompt-message">
              {prompt.message}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {attachmentPrompt ? (
            <>
              <button
                type="button"
                className="taomni-btn h-7 px-2.5 text-[12px]"
                data-testid="mail-attach-reminder-cancel"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-2.5 text-[12px]"
                data-testid="mail-attach-reminder-attach"
                onClick={onAttach}
              >
                Attach…
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-2.5 text-[12px]"
                data-primary="true"
                data-testid="mail-attach-reminder-send"
                onClick={onSendAnyway}
              >
                Send anyway
              </button>
            </>
          ) : (
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-[12px]"
              data-primary="true"
              data-testid="mail-compose-error-ok"
              onClick={onClose}
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import { Code } from "lucide-react";
import { type SetStateAction } from "react";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailSourceDialogContext {
  sourceView: { subject: string; content: string; } | null;
  setSourceView: import("react").Dispatch<SetStateAction<{ subject: string; content: string; } | null>>;
  copyText: (label: string, value: string | null | undefined) => void;
}

export function MailSourceDialog(context: MailSourceDialogContext) {
  const { sourceView, setSourceView, copyText } = context;
  return sourceView && (
    <div className="absolute inset-0 z-[140] bg-black/35 flex items-center justify-center p-5">
      <MailDraggableDialog
        title={`Source — ${sourceView.subject}`}
        icon={<Code className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Message source"
        minWidth={560}
        minHeight={360}
        className="w-[min(1000px,92vw)] h-[min(720px,86vh)] min-h-[420px]"
        onClose={() => setSourceView(null)}
        headerActions={(
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            onClick={() => copyText("message source", sourceView.content)}
          >
            Copy all
          </button>
        )}
      >
        <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-bg)]">
          <pre className="p-3 text-[12px] leading-5 whitespace-pre-wrap break-words taomni-mono">
            {sourceView.content}
          </pre>
        </div>
      </MailDraggableDialog>
    </div>
  );
}

import { useMemo } from "react";
import { Sparkles, X } from "lucide-react";

interface EditorAiRewriteDialogProps {
  path: string;
  original: string;
  proposal: string;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onProposalChange: (value: string) => void;
  onClose: () => void;
  onApply: () => void;
  onRegenerate: () => void;
  busy?: boolean;
}

export function EditorAiRewriteDialog({
  path,
  original,
  proposal,
  instruction,
  onInstructionChange,
  onProposalChange,
  onClose,
  onApply,
  onRegenerate,
  busy = false,
}: EditorAiRewriteDialogProps) {
  const previewLines = useMemo(() => {
    const oldLines = original.split("\n");
    const newLines = proposal.split("\n");
    const max = Math.max(oldLines.length, newLines.length);
    const rows: Array<{ kind: "same" | "old" | "new"; text: string }> = [];
    for (let index = 0; index < max; index += 1) {
      const oldLine = oldLines[index];
      const newLine = newLines[index];
      if (oldLine === newLine) {
        if (oldLine != null) rows.push({ kind: "same", text: oldLine });
        continue;
      }
      if (oldLine != null) rows.push({ kind: "old", text: oldLine });
      if (newLine != null) rows.push({ kind: "new", text: newLine });
    }
    return rows.slice(0, 500);
  }, [original, proposal]);

  return (
    <div
      data-testid="code-workspace-ai-rewrite-dialog"
      className="fixed inset-0 z-[430] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(720px,90vh)] w-[min(960px,95vw)] flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <Sparkles className="h-4 w-4 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">AI rewrite preview</div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">{path}</div>
          </div>
          <button
            type="button"
            aria-label="Close AI rewrite preview"
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2 space-y-2">
          <div>
            <label className="mb-1 block text-[10px] text-[var(--taomni-code-muted)]">Instruction</label>
            <div className="flex gap-2">
              <input
                value={instruction}
                onChange={(event) => onInstructionChange(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[11px] text-[var(--taomni-code-text)] outline-none"
                placeholder="e.g. simplify this function and keep behavior"
              />
              <button
                type="button"
                className="h-8 rounded px-2 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                disabled={busy}
                onClick={onRegenerate}
              >
                Restage
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-[var(--taomni-code-muted)]">Proposal code (paste AI result)</label>
            <textarea
              data-testid="code-workspace-ai-rewrite-proposal"
              value={proposal}
              onChange={(event) => onProposalChange(event.target.value)}
              rows={5}
              className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 font-mono text-[11px] text-[var(--taomni-code-text)] outline-none"
            />
          </div>
          <p className="text-[10px] text-[var(--taomni-code-muted)]">
            Stages a rewrite/fix prompt into AI chat with the selection context. Paste the returned code into the proposal box, review the diff, then apply.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
          {previewLines.map((line, index) => (
            <div
              key={`${line.kind}:${index}`}
              className={
                line.kind === "old"
                  ? "flex bg-red-500/10 text-red-400"
                  : line.kind === "new"
                    ? "flex bg-green-500/10 text-green-400"
                    : "flex text-[var(--taomni-code-text)]"
              }
            >
              <span className="w-7 shrink-0 select-none text-center opacity-60">
                {line.kind === "old" ? "−" : line.kind === "new" ? "+" : " "}
              </span>
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line.text || " "}</pre>
            </div>
          ))}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <button
            type="button"
            className="h-7 rounded px-2 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="code-workspace-ai-rewrite-apply"
            className="h-7 rounded bg-[var(--taomni-accent)] px-2 text-[11px] text-white disabled:opacity-40"
            disabled={busy || proposal === original}
            onClick={onApply}
          >
            Apply proposal
          </button>
        </div>
      </div>
    </div>
  );
}

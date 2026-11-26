import { ModalSurface } from "../../../../ui/ModalSurface";
import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { parseVariables, updateNode, type VarNode } from "./debugPanelShared";
import { VariableRow } from "./VariableRow";

export interface EvaluateExpressionDialogProps {
  debug: CodeDebugSession;
  initialExpression?: string;
  onClose: () => void;
}

/**
 * IDEA's Evaluate dialog (Alt+F8): an expression field evaluated in the
 * selected frame with the result as an expandable tree, plus Add to Watches.
 */
export function EvaluateExpressionDialog({ debug, initialExpression = "", onClose }: EvaluateExpressionDialogProps) {
  const [expression, setExpression] = useState(initialExpression);
  const [result, setResult] = useState<VarNode | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = debug.state?.status === "stopped";


  const evaluate = async () => {
    const text = expression.trim();
    if (!text || !stopped || busy) return;
    setBusy(true);
    try {
      const value = await debug.evaluate(text, "repl");
      setResult({
        name: "result",
        value: value.value,
        type: value.type,
        variablesReference: value.variablesReference,
        parentRef: 0,
        children: null,
        expanded: false,
        dataBreakpointExpression: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const expand = (node: VarNode) => {
    setResult((current) => (current ? updateNode([current], node, (n) => ({ ...n, expanded: !n.expanded }))[0] ?? current : current));
    if (!node.expanded && node.children === null && node.variablesReference > 0) {
      void debug.fetchVariables(node.variablesReference).then((body) => {
        const children = parseVariables(body, node.variablesReference);
        setResult((current) => (current
          ? updateNode([current], node, (n) => ({ ...n, children, expanded: true }))[0] ?? current
          : current));
      });
    }
  };

  return createPortal(
    <ModalSurface
      data-testid="debug-evaluate-dialog"
      initialFocus="[data-testid=debug-evaluate-expression]"
      onCancel={onClose}
      aria-label="Evaluate"
      className="taomni-modal taomni-workspace-modal"
      data-bleed="true"
      style={{ width: "min(560px, calc(100vw - 32px))" }}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--taomni-code-border)] px-3">
        <span className="font-semibold">Evaluate</span>
        <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-[var(--taomni-hover)]" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-2 p-3">
        <textarea
            data-testid="debug-evaluate-expression"
          aria-label="Expression"
          rows={2}
          className="w-full resize-y rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-2 py-1 font-mono text-ui-body focus-visible:keyboard-outline focus:border-[var(--taomni-accent)]"
          placeholder={stopped ? "Expression" : "Evaluation needs a suspended program"}
          value={expression}
          onChange={(event) => setExpression(event.target.value)}
          onKeyDown={(event) => {
            // IDEA: Enter evaluates, Shift+Enter adds a line.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              void evaluate();
            }
          }}
        />
        <div className="text-ui-caption text-[var(--taomni-text-muted)]">Result:</div>
        <div data-testid="debug-evaluate-result" className="min-h-[80px] max-h-[40vh] overflow-auto rounded border border-[var(--taomni-code-border)] py-1">
          {result ? (
            <VariableRow node={result} depth={0} onExpand={expand} />
          ) : (
            <div className="px-2 text-[var(--taomni-text-muted)]">
              {stopped ? "Press Enter to evaluate." : "The program is not suspended."}
            </div>
          )}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3">
        <button
          type="button"
          data-testid="debug-evaluate-add-watch"
          disabled={!expression.trim()}
          className="h-6 rounded border border-[var(--taomni-code-border)] px-3 hover:bg-[var(--taomni-hover)] disabled:opacity-40"
          onClick={() => debug.addWatchExpression(expression.trim())}
        >
          Add to Watches
        </button>
        <button
          type="button"
          data-testid="debug-evaluate-submit"
          disabled={!stopped || !expression.trim() || busy}
          className="h-6 rounded bg-[var(--taomni-accent)] px-4 font-medium text-white hover:opacity-90 disabled:opacity-40"
          onClick={() => void evaluate()}
        >
          Evaluate
        </button>
      </div>
    </ModalSurface>,
    document.body,
  );
}

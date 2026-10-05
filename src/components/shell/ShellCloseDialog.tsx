import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import type { ClosePlanItem, CloseResult, CloseProgress } from "../../lib/shell/closeCoordinator";
import type { CloseChoice } from "../../lib/shell/types";

export function ShellCloseDialog({ items, errors, progress, onFinish }: { items: ClosePlanItem[]; errors: CloseResult["failed"]; progress?: CloseProgress; onFinish(choices: Record<string, CloseChoice> | null): void }) {
  const t = useT();
  const [choices, setChoices] = useState<Record<string, CloseChoice>>({});
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => { if (opener.current?.isConnected) opener.current.focus(); }; }, []);
  const risks = items.flatMap((item) => item.risks);
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" data-modal="true">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="shell-close-title" data-testid="shell-close-dialog"
      className="w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-32px)] overflow-auto rounded border p-4 shadow-xl"
      style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)", borderColor: "var(--taomni-divider)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.stopPropagation(); onFinish(null); }
        if (event.key === "Tab") {
          const controls = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]),select") ?? [])];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 id="shell-close-title" className="font-semibold mb-3">{t("shell.closeTitle")}</h2>
      {progress && <div data-testid="shell-close-summary" data-closed-count={progress.closed.length} data-remaining-count={progress.remaining.length} className="mb-3 text-sm">
        <p role="status">{t("shell.closeProgress", { closed: progress.closed.length, remaining: progress.remaining.length })}</p>
        {(["closed", "remaining"] as const).map((state) => <ul key={state}>{progress[state].map((target) => <li key={target.id} data-testid="shell-close-result" data-state={state} data-target-id={target.id}>{t(`shell.closeResult.${state}`)} · {target.title}</li>)}</ul>)}
      </div>}
      {!!items.length && <p data-testid="shell-close-count" className="mb-3 text-sm">{t("shell.closeCount", { count: items.length })}</p>}
      {items.map((item) => <section key={item.target.id} data-target-id={item.target.id} className="mb-3">
        <p className="font-medium">{item.target.title}</p>
        {item.risks.map((risk) => <div key={risk.id} data-testid="shell-close-risk" data-risk-kind={risk.kind} className="mt-2">
          <p className="text-sm mb-2">{risk.detail}</p>
          <div className="flex flex-wrap gap-2">{risk.choices.filter((choice) => choice !== "cancel").map((choice) => <button type="button" key={choice}
            data-testid={`shell-close-${choice}`} aria-pressed={choices[risk.id] === choice} className="taomni-button px-3 py-1"
            onClick={() => setChoices((old) => ({ ...old, [risk.id]: choice }))}>{t(`shell.close.${choice}`)}</button>)}</div>
        </div>)}
      </section>)}
      {errors.map((error) => <p key={error.id} role="alert" data-testid="shell-close-error" data-target-id={error.id} className="mb-3 text-red-500">{error.error}</p>)}
      <div className="flex justify-end gap-2">
        {!!progress?.remaining.length && <button type="button" data-testid="shell-close-retry-remaining" className="taomni-button px-3 py-1" onClick={() => onFinish({ "$remaining": "retry" })}>{t("shell.retryRemaining")}</button>}
        <button type="button" data-testid="shell-close-cancel" className="taomni-button px-3 py-1" onClick={() => onFinish(null)}>{t("common.cancel")}</button>
        <button type="button" data-testid="shell-close-confirm" className="taomni-button px-3 py-1" disabled={risks.some((risk) => !choices[risk.id])}
          onClick={() => onFinish(choices)}>{t(errors.length ? "common.ok" : "shell.closeConfirm")}</button>
      </div>
    </div>
  </div>;
}

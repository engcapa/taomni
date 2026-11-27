import { useId, useState, type ReactNode } from "react";
import { usePendingAction } from "./usePendingAction";

interface SettingsSwitchProps {
  "data-testid": string;
  label: string;
  description: string;
  icon: ReactNode;
  checked: boolean;
  saving: boolean;
  tone?: "info" | "warning";
  onToggle: () => Promise<void>;
}

/** UI-CHK-03. The persisted value determines the switch state after a save. */
export function SettingsSwitch({
  label, description, icon, checked, saving, tone = "info", onToggle, ...props
}: SettingsSwitchProps) {
  const descriptionId = useId();
  const errorId = useId();
  const [error, setError] = useState("");
  const action = usePendingAction(async () => {
    setError("");
    try {
      await onToggle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  });
  const busy = saving || action.busy;
  const selected = tone === "warning"
    ? "border-ui-warning-border bg-ui-warning-surface text-ui-warning"
    : "border-ui-info-border bg-ui-info-surface text-ui-info";

  return (
    <div>
      <button {...props} type="button" role="switch" aria-checked={checked}
        aria-label={label} aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
        aria-disabled={busy || undefined} aria-busy={busy || undefined}
        onClick={() => { if (!busy) void action.run(); }}
        className={`flex w-full items-center gap-3 rounded border p-3 text-left focus-visible:keyboard-outline aria-busy:cursor-wait ${
          checked ? selected : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
        }`}
      >
        <span aria-hidden="true" className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui-body font-semibold">{label}</span>
          <span id={descriptionId} className="block text-ui-small">{description}</span>
        </span>
        <span aria-hidden="true" className={`relative h-5 w-9 shrink-0 rounded-full ${
          checked ? "bg-[var(--taomni-primary-bg)]" : "bg-[var(--taomni-text-muted)]"
        }`}>
          <span className={`absolute left-0 top-0.5 size-4 rounded-full transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-[18px] bg-[var(--taomni-primary-text)]" : "translate-x-0.5 bg-[var(--taomni-bg)]"
          }`} />
        </span>
      </button>
      {error && <p id={errorId} role="alert" className="mt-1 select-text text-ui-small text-ui-danger">{error}</p>}
    </div>
  );
}

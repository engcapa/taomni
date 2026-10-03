import { useEffect, useRef, useState, type ReactNode } from "react";
import { effectiveSuspend, type DebugBreakpoint } from "../../dapDebugModel";
import { breakpointDisplayName, breakpointRefKey } from "../../debugBreakpointProperties";

export interface BreakpointPropertiesPanelProps {
  path: string;
  breakpoint: DebugBreakpoint;
  /** IDEA's gutter popup shows Enabled, Suspend and Condition only. */
  compact?: boolean;
  /** Other line breakpoints, for "Disable until hitting the following breakpoint". */
  otherBreakpoints: Array<{ path: string; line: number }>;
  onChange: (options: Partial<DebugBreakpoint>) => void;
  /** Enter in the condition field (IDEA closes the popup). */
  onSubmit?: () => void;
  autoFocusCondition?: boolean;
  /** Prefix for every control's data-testid. */
  testIdPrefix: string;
}

const inputClass = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-[var(--taomni-accent)] disabled:opacity-50";

/**
 * A text field that commits on blur/Enter and keeps its draft while the
 * owning checkbox is cleared, like IDEA's condition/log editors.
 */
function DraftField({
  testId,
  value,
  placeholder,
  disabled,
  autoFocus,
  ariaLabel,
  onCommit,
  onSubmit,
}: {
  testId: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onSubmit?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      data-testid={testId}
      aria-label={ariaLabel}
      className={inputClass}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(draft);
          onSubmit?.();
        }
      }}
    />
  );
}

function Check({
  testId,
  checked,
  onChange,
  children,
  disabled,
}: {
  testId: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 whitespace-nowrap">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * IDEA's breakpoint properties (XLightBreakpointPropertiesPanel): Enabled,
 * Suspend, Condition, then — outside the compact popup — Log, Remove once
 * hit, the dependency on another breakpoint and the pass count. The DAP
 * suspend policy is per session, so IDEA's All/Thread choice is not offered.
 */
export function BreakpointPropertiesPanel({
  path,
  breakpoint,
  compact = false,
  otherBreakpoints,
  onChange,
  onSubmit,
  autoFocusCondition = false,
  testIdPrefix,
}: BreakpointPropertiesPanelProps) {
  const id = (name: string) => `${testIdPrefix}-${name}`;
  const [conditionOn, setConditionOn] = useState(!!breakpoint.condition?.trim());
  const [conditionDraft, setConditionDraft] = useState(breakpoint.condition ?? "");
  const [expressionOn, setExpressionOn] = useState(!!breakpoint.logExpression?.trim());
  const [expressionDraft, setExpressionDraft] = useState(breakpoint.logExpression ?? "");
  const [passOn, setPassOn] = useState(!!breakpoint.hitCondition?.trim());
  const [passDraft, setPassDraft] = useState(breakpoint.hitCondition ?? "");
  const breakpointKey = breakpointRefKey(path, breakpoint.line);
  // A different breakpoint reuses the panel: reset the per-field drafts.
  useEffect(() => {
    setConditionOn(!!breakpoint.condition?.trim());
    setConditionDraft(breakpoint.condition ?? "");
    setExpressionOn(!!breakpoint.logExpression?.trim());
    setExpressionDraft(breakpoint.logExpression ?? "");
    setPassOn(!!breakpoint.hitCondition?.trim());
    setPassDraft(breakpoint.hitCondition ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakpointKey]);

  const enabled = breakpoint.enabled !== false;
  const suspend = effectiveSuspend(breakpoint);
  const masterKey = breakpoint.dependsOn
    ? breakpointRefKey(breakpoint.dependsOn.path, breakpoint.dependsOn.line)
    : "";
  const masters = otherBreakpoints.filter((ref) => !(ref.path === path && ref.line === breakpoint.line));

  return (
    <div data-testid={id("properties")} className="space-y-1.5 text-[11px] text-[var(--taomni-text)]">
      <Check testId={id("enabled")} checked={enabled} onChange={(checked) => onChange({ enabled: checked })}>
        Enabled
      </Check>
      <Check testId={id("suspend")} checked={suspend} onChange={(checked) => onChange({ suspend: checked })}>
        Suspend
      </Check>
      <div className="flex items-center gap-1.5">
        <Check
          testId={id("condition-enabled")}
          checked={conditionOn}
          onChange={(checked) => {
            setConditionOn(checked);
            onChange({ condition: checked && conditionDraft.trim() ? conditionDraft.trim() : undefined });
          }}
        >
          Condition:
        </Check>
        <DraftField
          testId={id("condition")}
          ariaLabel="Breakpoint condition"
          value={conditionDraft}
          placeholder="e.g. i > 10"
          autoFocus={autoFocusCondition}
          onCommit={(value) => {
            setConditionDraft(value);
            setConditionOn(!!value.trim());
            onChange({ condition: value.trim() || undefined });
          }}
          onSubmit={onSubmit}
        />
      </div>
      {!compact && (
        <>
          <div className="flex items-start gap-2 pt-1">
            <span className="w-8 shrink-0 pt-0.5 text-[var(--taomni-text-muted)]">Log:</span>
            <div className="min-w-0 flex-1 space-y-1">
              <Check
                testId={id("log-message")}
                checked={!!breakpoint.logHitMessage}
                onChange={(checked) => onChange({ logHitMessage: checked || undefined })}
              >
                "Breakpoint hit" message
              </Check>
              <Check
                testId={id("log-stack")}
                checked={!!breakpoint.logStack}
                onChange={(checked) => onChange({ logStack: checked || undefined })}
              >
                Stack trace
              </Check>
              <div className="flex items-center gap-1.5">
                <Check
                  testId={id("log-expression-enabled")}
                  checked={expressionOn}
                  onChange={(checked) => {
                    setExpressionOn(checked);
                    onChange({ logExpression: checked && expressionDraft.trim() ? expressionDraft.trim() : undefined });
                  }}
                >
                  Evaluate and log:
                </Check>
                <DraftField
                  testId={id("log-expression")}
                  ariaLabel="Expression to evaluate and log"
                  value={expressionDraft}
                  onCommit={(value) => {
                    setExpressionDraft(value);
                    setExpressionOn(!!value.trim());
                    onChange({ logExpression: value.trim() || undefined });
                  }}
                />
              </div>
              {!!breakpoint.logMessage?.trim() && (
                <label className="flex items-center gap-1.5">
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">Template:</span>
                  <DraftField
                    testId={id("log-template")}
                    ariaLabel="Log message template"
                    value={breakpoint.logMessage ?? ""}
                    onCommit={(value) => onChange({ logMessage: value.trim() || undefined })}
                  />
                </label>
              )}
            </div>
          </div>
          <Check
            testId={id("remove-once-hit")}
            checked={!!breakpoint.temporary}
            onChange={(checked) => onChange({ temporary: checked || undefined })}
          >
            Remove once hit
          </Check>
          <div className="space-y-1 pt-1">
            <div className="text-[var(--taomni-text-muted)]">Disable until hitting the following breakpoint:</div>
            <select
              data-testid={id("depends-on")}
              aria-label="Disable until hitting the following breakpoint"
              className="h-6 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 text-[11px]"
              value={masterKey}
              onChange={(event) => {
                const target = masters.find((ref) => breakpointRefKey(ref.path, ref.line) === event.target.value);
                onChange({ dependsOn: target ? { path: target.path, line: target.line } : undefined });
              }}
            >
              <option value="">&lt;None&gt;</option>
              {masters.map((ref) => (
                <option key={breakpointRefKey(ref.path, ref.line)} value={breakpointRefKey(ref.path, ref.line)}>
                  {breakpointDisplayName(ref.path, ref.line)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3 pl-1" role="radiogroup" aria-label="After hit">
              <span className="text-[var(--taomni-text-muted)]">After hit:</span>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  data-testid={id("after-hit-disable")}
                  name={id("after-hit")}
                  disabled={!breakpoint.dependsOn}
                  checked={!breakpoint.leaveEnabled}
                  onChange={() => onChange({ leaveEnabled: undefined })}
                />
                Disable again
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  data-testid={id("after-hit-leave")}
                  name={id("after-hit")}
                  disabled={!breakpoint.dependsOn}
                  checked={!!breakpoint.leaveEnabled}
                  onChange={() => onChange({ leaveEnabled: true })}
                />
                Leave enabled
              </label>
            </div>
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <Check
              testId={id("pass-count-enabled")}
              checked={passOn}
              onChange={(checked) => {
                setPassOn(checked);
                onChange({ hitCondition: checked && passDraft.trim() ? passDraft.trim() : undefined });
              }}
            >
              Pass count:
            </Check>
            <DraftField
              testId={id("pass-count")}
              ariaLabel="Pass count"
              value={passDraft}
              placeholder="e.g. 5"
              onCommit={(value) => {
                setPassDraft(value);
                setPassOn(!!value.trim());
                onChange({ hitCondition: value.trim() || undefined });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

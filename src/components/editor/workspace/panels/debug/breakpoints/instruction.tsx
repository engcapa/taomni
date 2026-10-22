import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  breakpointModesFor,
  instructionBreakpointKey,
  parseBreakpointModes,
  resolveBreakpointMode,
  type DebugBreakpointMode,
  type DebugInstructionBreakpoint,
} from "../../../dapDebugModel";
import type { CodeDebugSession } from "../../../useCodeDebugSession";
import { CommitField, Empty } from "../debugPanelShared";

/** DAP instruction breakpoints keyed by an adapter-owned reference and offset. */
export function InstructionBreakpointsView({ debug }: { debug: CodeDebugSession; }) {
  const [reference, setReference] = useState("");
  const [offset, setOffset] = useState("");
  const [preferredMode, setPreferredMode] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const active = !!debug.state && debug.state.status !== "terminated";
  const supported = debug.capabilities.supportsInstructionBreakpoints === true;
  const modes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "instruction");
  const mode = resolveBreakpointMode(preferredMode || undefined, modes, "instruction");
  const canAdd = active && supported;
  const entries = debug.instructionBreakpoints.slice().sort((left, right) => (
    left.adapterId.localeCompare(right.adapterId)
    || left.instructionReference.localeCompare(right.instructionReference)
    || (left.offset ?? 0) - (right.offset ?? 0)
  ));

  const add = () => {
    const instructionReference = reference.trim();
    if (!instructionReference || !canAdd) return;
    const rawOffset = offset.trim();
    if (rawOffset && !/^[+-]?\d+$/.test(rawOffset)) {
      setNotice("Instruction offset must be a signed decimal integer");
      return;
    }
    const parsedOffset = rawOffset ? Number(rawOffset) : undefined;
    if (parsedOffset !== undefined && !Number.isSafeInteger(parsedOffset)) {
      setNotice("Instruction offset is outside the safe integer range");
      return;
    }
    const added = debug.addInstructionBreakpoint({
      instructionReference,
      offset: parsedOffset,
      mode,
    });
    if (!added) {
      setNotice("Instruction breakpoint is invalid, duplicated, or unsupported");
      return;
    }
    setReference("");
    setOffset("");
    setNotice(null);
  };

  return (
    <div
      data-testid="debug-instruction-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="space-y-1 px-3 py-1">
        <div className="flex items-center gap-1">
          <span className="w-24 shrink-0 text-[10px] font-medium text-[var(--taomni-text-muted)]">
            Instruction
          </span>
          <input
            data-testid="debug-instruction-breakpoint-reference"
            aria-label="Instruction reference"
            className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
            placeholder="Address or instruction reference"
            maxLength={4096}
            value={reference}
            disabled={!canAdd}
            onChange={(event) => setReference(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") add(); }}
          />
          <button
            type="button"
            data-testid="debug-instruction-breakpoint-add"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
            title={canAdd ? "Add instruction breakpoint" : "The active adapter does not support instruction breakpoints"}
            aria-label="Add instruction breakpoint"
            disabled={!canAdd || !reference.trim()}
            onClick={add}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-1">
          <span aria-hidden="true" />
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <label className="flex min-w-0 flex-1 basis-24 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
              <span className="shrink-0">Offset</span>
              <input
                data-testid="debug-instruction-breakpoint-offset"
                aria-label="Instruction breakpoint offset"
                className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
                inputMode="numeric"
                placeholder="optional"
                value={offset}
                disabled={!canAdd}
                onChange={(event) => setOffset(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") add(); }}
              />
            </label>
            {modes.length > 0 && (
              <select
                data-testid="debug-instruction-breakpoint-mode"
                aria-label="Instruction breakpoint mode"
                title={modes.find((entry) => entry.mode === mode)?.description}
                className="h-5 min-w-0 max-w-full flex-1 basis-24 truncate rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 text-[10px]"
                value={mode ?? modes[0].mode}
                disabled={!canAdd}
                onChange={(event) => setPreferredMode(event.target.value)}
              >
                {modes.map((entry) => (
                  <option key={entry.mode} value={entry.mode}>{entry.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
      {active && !supported && (
        <div data-testid="debug-instruction-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support instruction breakpoints.
        </div>
      )}
      {notice && (
        <div data-testid="debug-instruction-breakpoint-notice" role="status" className="px-3 pb-1 text-[10px] text-rose-500">
          {notice}
        </div>
      )}
      {entries.length === 0 && <Empty text="No instruction breakpoints." />}
      {entries.map((breakpoint, index) => {
        const key = instructionBreakpointKey(breakpoint);
        const disabled = breakpoint.enabled === false;
        const belongsToActiveAdapter = activeSession?.adapterId === breakpoint.adapterId;
        const runtime = belongsToActiveAdapter ? debug.instructionBreakpointRuntime[key] : undefined;
        const bindingHint = active && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const open = editingKey === key;
        const rowMode = belongsToActiveAdapter
          ? resolveBreakpointMode(breakpoint.mode, modes, "instruction")
          : breakpoint.mode;
        const rowModeLabel = modes.find((entry) => entry.mode === rowMode)?.label ?? rowMode;
        return (
          <div
            key={key}
            data-testid="debug-instruction-breakpoint-row"
            data-instruction-reference={breakpoint.instructionReference}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-instruction-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable instruction breakpoint" : "Disable instruction breakpoint"}
                onChange={(event) => debug.setInstructionBreakpointOptions(
                  key,
                  { enabled: event.target.checked },
                )}
              />
              <span className={`min-w-0 flex-1 truncate font-mono ${disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
                }`} title={`${breakpoint.adapterId}: ${breakpoint.instructionReference}`}>
                {breakpoint.instructionReference}
                {breakpoint.offset !== undefined && (
                  <span className="ml-1 text-[var(--taomni-text-muted)]">
                    {breakpoint.offset >= 0 ? "+" : ""}{breakpoint.offset}
                  </span>
                )}
                <span className="ml-2 text-[10px] text-[var(--taomni-text-muted)]">{breakpoint.adapterId}</span>
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {rowModeLabel && <span className="ml-2 text-emerald-600 dark:text-emerald-400">{rowModeLabel}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-instruction-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-testid={`debug-instruction-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingKey(open ? null : key)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-instruction-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove instruction breakpoint"
                onClick={() => debug.removeInstructionBreakpoint(key)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <InstructionBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                modes={belongsToActiveAdapter ? modes : []}
                onChange={(options) => debug.setInstructionBreakpointOptions(key, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function InstructionBreakpointEditor({
  breakpoint,
  index,
  modes,
  onChange,
}: {
  breakpoint: DebugInstructionBreakpoint;
  index: number;
  modes: DebugBreakpointMode[];
  onChange: (
    options: Partial<Pick<DebugInstructionBreakpoint, "condition" | "hitCondition" | "mode">>,
  ) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  const mode = resolveBreakpointMode(breakpoint.mode, modes, "instruction");
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-instruction-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-instruction-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
      {modes.length > 0 && (
        <label className="flex items-center gap-2 text-[10px] text-[var(--taomni-text-muted)]">
          <span className="w-20 shrink-0">Mode</span>
          <select
            data-testid={`debug-instruction-breakpoint-row-mode-${index}`}
            aria-label={`Instruction breakpoint mode for ${breakpoint.instructionReference}`}
            className={field}
            value={mode ?? modes[0].mode}
            onChange={(event) => onChange({ mode: event.target.value })}
          >
            {modes.map((entry) => (
              <option key={entry.mode} value={entry.mode}>{entry.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

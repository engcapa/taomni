import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type DebugFunctionBreakpoint } from "../../../dapDebugModel";
import type { CodeDebugSession } from "../../../useCodeDebugSession";
import { CommitField, Empty } from "../debugPanelShared";

/** DAP function/method breakpoints, configured independently of source files. */
export function FunctionBreakpointsView({ debug }: { debug: CodeDebugSession; }) {
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const entries = debug.functionBreakpoints
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  const active = !!debug.state && debug.state.status !== "terminated";
  const supported = debug.capabilities.supportsFunctionBreakpoints === true;
  const canAdd = !active || supported;
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed || !canAdd) return;
    debug.addFunctionBreakpoint(trimmed);
    setName("");
  };
  return (
    <div
      data-testid="debug-function-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="flex items-center gap-1 px-3 py-1">
        <span className="w-24 shrink-0 text-[10px] font-medium text-[var(--taomni-text-muted)]">
          Function / method
        </span>
        <input
          data-testid="debug-function-breakpoint-input"
          aria-label="Function breakpoint name"
          className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
          placeholder="Type a qualified function name"
          maxLength={1024}
          value={name}
          disabled={!canAdd}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
        />
        <button
          type="button"
          data-testid="debug-function-breakpoint-add"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
          title={canAdd ? "Add function breakpoint" : "The active adapter does not support function breakpoints"}
          aria-label="Add function breakpoint"
          disabled={!canAdd || !name.trim()}
          onClick={add}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      {active && !supported && (
        <div data-testid="debug-function-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support function breakpoints.
        </div>
      )}
      {entries.length === 0 && <Empty text="No function breakpoints." />}
      {entries.map((breakpoint, index) => {
        const disabled = breakpoint.enabled === false;
        const runtime = debug.functionBreakpointRuntime[breakpoint.name];
        const bindingHint = active && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const open = editingName === breakpoint.name;
        return (
          <div
            key={breakpoint.name}
            data-testid="debug-function-breakpoint-row"
            data-function-name={breakpoint.name}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-function-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable function breakpoint" : "Disable function breakpoint"}
                onChange={(event) => debug.setFunctionBreakpointOptions(
                  breakpoint.name,
                  { enabled: event.target.checked },
                )}
              />
              <span className={`min-w-0 flex-1 truncate font-mono ${disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
                }`} title={breakpoint.name}>
                {breakpoint.name}
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-function-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-testid={`debug-function-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingName(open ? null : breakpoint.name)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-function-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove function breakpoint"
                onClick={() => debug.removeFunctionBreakpoint(breakpoint.name)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <FunctionBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                onChange={(options) => debug.setFunctionBreakpointOptions(breakpoint.name, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FunctionBreakpointEditor({
  breakpoint,
  index,
  onChange,
}: {
  breakpoint: DebugFunctionBreakpoint;
  index: number;
  onChange: (options: Partial<DebugFunctionBreakpoint>) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-function-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-function-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
    </div>
  );
}

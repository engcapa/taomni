import { Trash2 } from "lucide-react";
import { breakpointModesFor, parseBreakpointModes, resolveBreakpointMode, sortedBreakpoints } from "../../dapDebugModel";
import { BreakpointEditor } from "./BreakpointEditor";
import { DataBreakpointsView } from "./breakpoints/data";
import { FunctionBreakpointsView } from "./breakpoints/function";
import { InstructionBreakpointsView } from "./breakpoints/instruction";
import { type BreakpointsViewProps } from "./breakpoints/model";
import { Empty } from "./debugPanelShared";

/**
 * Breakpoints view (IDEA's breakpoints dialog, inline): every breakpoint in the
 * workspace with enable/disable, condition / hit count / log message editing,
 * removal, and click-to-reveal. Language-agnostic — it renders the DAP fields.
 */
export function BreakpointsView({
  debug,
  editing,
  setEditing,
  onOpenBreakpoint,
  dataBreakpointModes,
  dataBreakpointMode,
  onDataBreakpointModeChange,
  includeChildViews = true,
}: BreakpointsViewProps) {
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const sourceModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "source");
  const entries = Object.entries(debug.breakpoints)
    .flatMap(([path, list]) => sortedBreakpoints(list).map((bp) => ({ path, bp })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line);

  return (
    <>
      {entries.length === 0 && (
        <Empty text="No line breakpoints. Click a line's gutter, or press Ctrl+F8." />
      )}
      {entries.map(({ path, bp }) => {
        const open = editing?.path === path && editing.line === bp.line;
        const disabled = bp.enabled === false;
        // Adapter binding state for this line (in-session only): surface a
        // pending/failed reason so an unhittable breakpoint is not silent.
        const runtime = debug.breakpointRuntime[path]?.[bp.line];
        const sessionRunning = !!debug.state && debug.state.status !== "terminated";
        const bindingHint = sessionRunning && !disabled && runtime && runtime.status !== "verified"
          ? { status: runtime.status, message: runtime.message }
          : null;
        const sourceMode = activeSession
          ? resolveBreakpointMode(bp.adapterModes?.[activeSession.adapterId], sourceModes, "source")
          : undefined;
        const sourceModeMetadata = sourceModes.find((mode) => mode.mode === sourceMode);
        return (
          <div key={`${path}:${bp.line}`} className="border-b border-[var(--taomni-code-border)]/40 last:border-b-0">
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-breakpoint-enabled-${bp.line}`}
                checked={!disabled}
                title={disabled ? "Enable breakpoint" : "Disable breakpoint"}
                onChange={(e) => debug.setBreakpointOptions(path, bp.line, { enabled: e.target.checked })}
              />
              <button
                type="button"
                data-testid={`debug-breakpoint-${bp.line}`}
                className={`min-w-0 flex-1 truncate text-left ${disabled ? "text-[var(--taomni-text-muted)] line-through" : ""}`}
                onClick={() => onOpenBreakpoint?.(path, bp.line)}
                title={`${path}:${bp.line}`}
              >
                {path.split(/[\\/]/).pop()}:{bp.line}
                {bp.condition && <span className="ml-2 text-amber-500">if {bp.condition}</span>}
                {bp.hitCondition && <span className="ml-2 text-amber-500">hit {bp.hitCondition}</span>}
                {bp.logMessage && <span className="ml-2 text-sky-500">log</span>}
                {sourceModeMetadata && (
                  <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                    {sourceModeMetadata.label}
                  </span>
                )}
                {bindingHint && (
                  <span
                    data-testid={`debug-breakpoint-binding-${bp.line}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-testid={`debug-breakpoint-edit-${bp.line}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditing(open ? null : { path, line: bp.line })}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-breakpoint-remove-${bp.line}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                onClick={() => debug.removeBreakpoint(path, bp.line)}
                title="Remove breakpoint"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <BreakpointEditor
                breakpoint={bp}
                adapterId={activeSession?.adapterId ?? null}
                modes={sourceModes}
                onChange={(options) => debug.setBreakpointOptions(path, bp.line, options)}
                onModeChange={(mode) => debug.setBreakpointMode(path, bp.line, mode)}
              />
            )}
          </div>
        );
      })}
      {includeChildViews && (
        <>
          <FunctionBreakpointsView debug={debug} />
          <InstructionBreakpointsView debug={debug} />
          <DataBreakpointsView
            debug={debug}
            modes={dataBreakpointModes}
            newMode={dataBreakpointMode}
            onNewModeChange={onDataBreakpointModeChange}
          />
        </>
      )}
    </>
  );
}

export { type BreakpointsViewProps } from "./breakpoints/model";

export { FunctionBreakpointEditor, FunctionBreakpointsView } from "./breakpoints/function";

export { InstructionBreakpointEditor, InstructionBreakpointsView } from "./breakpoints/instruction";

export { DataBreakpointEditor, DataBreakpointsView } from "./breakpoints/data";

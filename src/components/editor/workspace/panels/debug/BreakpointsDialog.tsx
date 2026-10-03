import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, X } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  breakpointModesFor,
  effectiveSuspend,
  parseBreakpointModes,
  resolveBreakpointMode,
  sortedBreakpoints,
} from "../../dapDebugModel";
import { breakpointDisplayName, breakpointRefKey } from "../../debugBreakpointProperties";
import { BreakpointPropertiesPanel } from "./BreakpointPropertiesPanel";
import { DataBreakpointsView, FunctionBreakpointsView } from "./BreakpointsView";
import { ExceptionBreakpointsView } from "./ExceptionBreakpointsView";

type Selection =
  | { kind: "line"; path: string; line: number }
  | { kind: "group"; group: "line" | "function" | "exception" | "data" };

export interface BreakpointsDialogProps {
  debug: CodeDebugSession;
  /** Breakpoint to select on open (IDEA "More" from the gutter popup). */
  initial?: { path: string; line: number } | null;
  onOpenBreakpoint: (path: string, line: number) => void;
  onClose: () => void;
}

const GROUP_LABELS: Record<"line" | "function" | "exception" | "data", string> = {
  line: "Line Breakpoints",
  function: "Function Breakpoints",
  exception: "Exception Breakpoints",
  data: "Data Breakpoints",
};

/**
 * IDEA's View Breakpoints dialog (Ctrl+Shift+F8): every breakpoint grouped by
 * kind on the left with enable checkboxes, the selected breakpoint's full
 * properties on the right. Space toggles, Delete removes, F4/Enter jumps to
 * the source.
 */
export function BreakpointsDialog({ debug, initial = null, onOpenBreakpoint, onClose }: BreakpointsDialogProps) {
  const lineEntries = useMemo(() => Object.entries(debug.breakpoints)
    .flatMap(([path, list]) => sortedBreakpoints(list).map((bp) => ({ path, bp })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line), [debug.breakpoints]);
  const [selection, setSelection] = useState<Selection>(() => (
    initial
      ? { kind: "line", path: initial.path, line: initial.line }
      : lineEntries[0]
        ? { kind: "line", path: lineEntries[0].path, line: lineEntries[0].bp.line }
        : { kind: "group", group: "line" }
  ));
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { treeRef.current?.focus(); }, []);

  const rows: Selection[] = [
    { kind: "group", group: "line" },
    ...lineEntries.map(({ path, bp }) => ({ kind: "line" as const, path, line: bp.line })),
    { kind: "group", group: "function" },
    { kind: "group", group: "exception" },
    { kind: "group", group: "data" },
  ];
  const rowKey = (row: Selection) => (row.kind === "line" ? `line:${breakpointRefKey(row.path, row.line)}` : `group:${row.group}`);
  const selectedKey = rowKey(selection);
  const selectedIndex = Math.max(0, rows.findIndex((row) => rowKey(row) === selectedKey));
  const selectedLine = selection.kind === "line"
    ? lineEntries.find((entry) => entry.path === selection.path && entry.bp.line === selection.line) ?? null
    : null;
  // A breakpoint removed elsewhere (or here) falls back to its group.
  useEffect(() => {
    if (selection.kind === "line" && !selectedLine) setSelection({ kind: "group", group: "line" });
  }, [selectedLine, selection.kind]);

  const others = lineEntries.map(({ path, bp }) => ({ path, line: bp.line }));
  const dataModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "data");
  const [dataMode, setDataMode] = useState("");

  const removeSelected = () => {
    if (selection.kind !== "line") return;
    const index = rows.findIndex((row) => rowKey(row) === selectedKey);
    debug.removeBreakpoint(selection.path, selection.line);
    const next = rows[index + 1]?.kind === "line" ? rows[index + 1] : rows[index - 1];
    if (next) setSelection(next);
  };

  const count = (group: "line" | "function" | "exception" | "data") => {
    if (group === "line") return lineEntries.length;
    if (group === "function") return debug.functionBreakpoints.length;
    if (group === "exception") return debug.exceptionBreakpoints.filter((entry) => entry.enabled).length
      + debug.exceptionBreakpointRules.length;
    return debug.dataBreakpoints.length;
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Breakpoints"
        data-testid="debug-breakpoints-dialog"
        className="flex h-[520px] max-h-[90vh] w-[820px] max-w-[95vw] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[11px] shadow-xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-semibold">Breakpoints</span>
          <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-[var(--taomni-hover-bg)]" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[300px] shrink-0 flex-col border-r border-[var(--taomni-code-border)]">
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-1.5">
              <button
                type="button"
                data-testid="debug-breakpoints-dialog-remove"
                aria-label="Remove"
                title="Remove (Delete)"
                disabled={selection.kind !== "line"}
                className="rounded p-1 hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
                onClick={removeSelected}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="ml-auto pr-1 text-[10px] text-[var(--taomni-text-muted)]">
                {debug.breakpointsMuted ? "Muted" : ""}
              </span>
            </div>
            <div
              ref={treeRef}
              role="tree"
              aria-label="Breakpoints"
              tabIndex={0}
              data-testid="debug-breakpoints-dialog-tree"
              className="min-h-0 flex-1 overflow-auto py-1 outline-none"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = rows[Math.min(rows.length - 1, Math.max(0, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)))];
                  if (next) setSelection(next);
                } else if (event.key === " " && selectedLine) {
                  event.preventDefault();
                  debug.toggleBreakpointEnabled(selectedLine.path, selectedLine.bp.line);
                } else if (event.key === "Delete") {
                  event.preventDefault();
                  removeSelected();
                } else if ((event.key === "F4" || event.key === "Enter") && selectedLine) {
                  event.preventDefault();
                  onOpenBreakpoint(selectedLine.path, selectedLine.bp.line);
                  onClose();
                }
              }}
            >
              {rows.map((row) => {
                const key = rowKey(row);
                const selected = key === selectedKey;
                const base = `flex w-full items-center gap-1.5 py-0.5 pr-2 text-left select-none ${
                  selected ? "bg-[var(--taomni-accent)]/20" : "hover:bg-[var(--taomni-hover-bg)]"
                }`;
                if (row.kind === "group") {
                  return (
                    <div
                      key={key}
                      role="treeitem"
                      aria-selected={selected}
                      data-testid={`debug-breakpoints-dialog-group-${row.group}`}
                      className={`${base} pl-2 font-medium`}
                      onClick={() => setSelection(row)}
                    >
                      <span className="truncate">{GROUP_LABELS[row.group]}</span>
                      <span className="ml-auto text-[10px] tabular-nums text-[var(--taomni-text-muted)]">{count(row.group)}</span>
                    </div>
                  );
                }
                const entry = lineEntries.find((candidate) => candidate.path === row.path && candidate.bp.line === row.line);
                if (!entry) return null;
                const disabled = entry.bp.enabled === false;
                return (
                  <div
                    key={key}
                    role="treeitem"
                    aria-selected={selected}
                    data-testid="debug-breakpoints-dialog-line"
                    data-breakpoint-path={row.path}
                    data-breakpoint-line={row.line}
                    className={`${base} pl-5`}
                    onClick={() => setSelection(row)}
                    onDoubleClick={() => {
                      onOpenBreakpoint(row.path, row.line);
                      onClose();
                    }}
                    title={row.path}
                  >
                    <input
                      type="checkbox"
                      data-testid={`debug-breakpoints-dialog-enabled-${row.line}`}
                      aria-label={`Enable ${breakpointDisplayName(row.path, row.line)}`}
                      checked={!disabled}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => debug.toggleBreakpointEnabled(row.path, row.line)}
                    />
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                        effectiveSuspend(entry.bp) ? "bg-[#e55765]" : "bg-[#f2b93b]"
                      } ${disabled ? "opacity-40" : ""}`}
                    />
                    <span className={`truncate ${disabled ? "text-[var(--taomni-text-muted)]" : ""}`}>
                      {breakpointDisplayName(row.path, row.line)}
                    </span>
                    {entry.bp.condition && <span className="truncate text-[10px] text-amber-500">{entry.bp.condition}</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <div data-testid="debug-breakpoints-dialog-details" className="min-w-0 flex-1 overflow-auto p-3">
            {selectedLine ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-semibold">{breakpointDisplayName(selectedLine.path, selectedLine.bp.line)}</span>
                  <button
                    type="button"
                    data-testid="debug-breakpoints-dialog-view-source"
                    className="ml-auto text-[var(--taomni-accent)] hover:underline"
                    onClick={() => {
                      onOpenBreakpoint(selectedLine.path, selectedLine.bp.line);
                      onClose();
                    }}
                  >
                    View Source (F4)
                  </button>
                </div>
                <BreakpointPropertiesPanel
                  path={selectedLine.path}
                  breakpoint={selectedLine.bp}
                  otherBreakpoints={others}
                  onChange={(options) => debug.setBreakpointOptions(selectedLine.path, selectedLine.bp.line, options)}
                  testIdPrefix="debug-breakpoints-dialog"
                />
              </>
            ) : selection.kind === "group" && selection.group === "function" ? (
              <FunctionBreakpointsView debug={debug} />
            ) : selection.kind === "group" && selection.group === "exception" ? (
              debug.availableExceptionFilters.length > 0 || debug.exceptionBreakpointRules.length > 0
                ? <ExceptionBreakpointsView debug={debug} />
                : <div className="text-[var(--taomni-text-muted)]">Exception breakpoints are listed once a debug adapter reports its exception filters.</div>
            ) : selection.kind === "group" && selection.group === "data" ? (
              <DataBreakpointsView
                debug={debug}
                modes={dataModes}
                newMode={resolveBreakpointMode(dataMode || undefined, dataModes, "data")}
                onNewModeChange={setDataMode}
              />
            ) : (
              <div className="text-[var(--taomni-text-muted)]">
                {lineEntries.length === 0
                  ? "No line breakpoints. Click a line's gutter, or press Ctrl+F8."
                  : "Select a breakpoint to edit its properties."}
              </div>
            )}
          </div>
        </div>
        <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3">
          <button
            type="button"
            data-testid="debug-breakpoints-dialog-done"
            className="h-6 rounded bg-[var(--taomni-accent)] px-4 text-[11px] font-medium text-white hover:opacity-90"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

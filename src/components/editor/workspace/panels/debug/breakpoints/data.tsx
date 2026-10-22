import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { dataBreakpointKey, type DebugBreakpointMode, type DebugDataBreakpoint } from "../../../dapDebugModel";
import type { CodeDebugSession } from "../../../useCodeDebugSession";
import { CommitField, dataAccessTypeLabel, Empty } from "../debugPanelShared";

/** DAP data breakpoints/watchpoints discovered from Variables or Watch. */
export function DataBreakpointsView({
  debug,
  modes,
  newMode,
  onNewModeChange,
}: {
  debug: CodeDebugSession;
  modes: DebugBreakpointMode[];
  newMode: string | undefined;
  onNewModeChange: (mode: string) => void;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetBytes, setTargetBytes] = useState("");
  const [targetAsAddress, setTargetAsAddress] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);
  const [targetNotice, setTargetNotice] = useState<{ added: boolean; message: string; } | null>(null);
  const entries = debug.dataBreakpoints.slice().sort((left, right) => (
    left.adapterId < right.adapterId ? -1
      : left.adapterId > right.adapterId ? 1
        : left.description < right.description ? -1
          : left.description > right.description ? 1
            : left.dataId < right.dataId ? -1 : left.dataId > right.dataId ? 1 : 0
  ));
  const active = !!debug.state && debug.state.status !== "terminated";
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const supported = debug.capabilities.supportsDataBreakpoints === true;
  const supportsBytes = debug.capabilities.supportsDataBreakpointBytes === true;
  const stopped = debug.state?.status === "stopped";
  const canAddTarget = supported && stopped && !addingTarget;
  const appliesToActiveSession = (breakpoint: DebugDataBreakpoint) => (
    breakpoint.sessionId
      ? breakpoint.sessionId === activeSession?.id
      : breakpoint.adapterId === activeSession?.adapterId
  );
  const hasUnsupportedEntries = active && !supported && entries.some((breakpoint) => (
    appliesToActiveSession(breakpoint) && breakpoint.enabled !== false
  ));

  const addTarget = async () => {
    const name = targetName.trim();
    if (!name || !canAddTarget) return;
    const rawBytes = targetBytes.trim();
    const bytes = rawBytes ? Number(rawBytes) : undefined;
    if (rawBytes && (!Number.isInteger(bytes) || (bytes as number) <= 0)) {
      setTargetNotice({ added: false, message: "Byte count must be a positive integer" });
      return;
    }
    setAddingTarget(true);
    setTargetNotice(null);
    const result = await debug.addDataBreakpoint({
      name,
      frameId: targetAsAddress ? undefined : (debug.state?.selectedFrameId ?? debug.state?.frames[0]?.id ?? undefined),
      bytes: supportsBytes ? bytes : undefined,
      asAddress: supportsBytes && targetAsAddress ? true : undefined,
      mode: newMode,
    });
    setAddingTarget(false);
    setTargetNotice(result);
    if (result.added) {
      setTargetName("");
      setTargetBytes("");
      setTargetAsAddress(false);
    }
  };

  return (
    <div
      data-testid="debug-data-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-medium text-[var(--taomni-text-muted)]">Data watchpoints</span>
        {modes.length > 0 && (
          <select
            data-testid="debug-data-breakpoint-mode"
            aria-label="Mode for new data breakpoint"
            title={modes.find((mode) => mode.mode === newMode)?.description
              ?? "Mode for new data breakpoints"}
            className="h-5 min-w-0 max-w-28 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            value={newMode ?? modes[0].mode}
            onChange={(event) => onNewModeChange(event.target.value)}
          >
            {modes.map((mode) => (
              <option key={mode.mode} value={mode.mode}>{mode.label}</option>
            ))}
          </select>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-[var(--taomni-text-muted)]">{entries.length}</span>
      </div>
      {canAddTarget && (
        <div className="space-y-1 px-3 pb-1" data-testid="debug-data-breakpoint-create">
          <div className="flex items-center gap-1">
            <input
              data-testid="debug-data-breakpoint-target"
              aria-label="Data breakpoint expression or address"
              className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
              placeholder={supportsBytes ? "Expression or address" : "Expression"}
              maxLength={4096}
              value={targetName}
              onChange={(event) => setTargetName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void addTarget(); }}
            />
            <button
              type="button"
              data-testid="debug-data-breakpoint-add"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
              title="Add data breakpoint for the expression or address"
              aria-label="Add data breakpoint"
              disabled={!targetName.trim() || addingTarget}
              onClick={() => void addTarget()}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          {supportsBytes && (
            <div className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
                <span className="shrink-0">Bytes</span>
                <input
                  data-testid="debug-data-breakpoint-bytes"
                  aria-label="Data breakpoint byte count"
                  className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
                  inputMode="numeric"
                  placeholder="optional range size"
                  value={targetBytes}
                  onChange={(event) => setTargetBytes(event.target.value)}
                />
              </label>
              <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]" title="Interpret the target as a decimal or hexadecimal memory address">
                <input
                  type="checkbox"
                  data-testid="debug-data-breakpoint-as-address"
                  aria-label="Treat target as memory address"
                  checked={targetAsAddress}
                  onChange={(event) => setTargetAsAddress(event.target.checked)}
                />
                Address
              </label>
            </div>
          )}
          {targetNotice && (
            <div
              data-testid="debug-data-breakpoint-create-notice"
              role="status"
              className={targetNotice.added ? "text-emerald-500" : "text-rose-500"}
            >
              {targetNotice.message}
            </div>
          )}
        </div>
      )}
      {hasUnsupportedEntries && (
        <div data-testid="debug-data-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support data breakpoints.
        </div>
      )}
      {entries.length === 0 && <Empty text="No data watchpoints." />}
      {entries.map((breakpoint, index) => {
        const key = dataBreakpointKey(breakpoint);
        const disabled = breakpoint.enabled === false;
        const applicable = appliesToActiveSession(breakpoint);
        const runtime = debug.dataBreakpointRuntime[key];
        const bindingHint = active && applicable && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const modeLabel = breakpoint.mode
          ? (breakpoint.adapterId === activeSession?.adapterId
            ? modes.find((mode) => mode.mode === breakpoint.mode)?.label ?? breakpoint.mode
            : breakpoint.mode)
          : null;
        const open = editingKey === key;
        return (
          <div
            key={key}
            data-testid="debug-data-breakpoint-row"
            data-data-breakpoint-persistent={breakpoint.canPersist ? "true" : "false"}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-data-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable data breakpoint" : "Disable data breakpoint"}
                onChange={(event) => debug.setDataBreakpointOptions(key, { enabled: event.target.checked })}
              />
              <span
                className={`min-w-0 flex-1 truncate font-mono ${disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
                  }`}
                title={breakpoint.description}
              >
                {breakpoint.description}
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {breakpoint.asAddress && <span className="ml-2 text-sky-600 dark:text-sky-400">address</span>}
                {breakpoint.bytes && <span className="ml-2 text-sky-600 dark:text-sky-400">{breakpoint.bytes} bytes</span>}
                {modeLabel && <span className="ml-2 text-emerald-600 dark:text-emerald-400">{modeLabel}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-data-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              {breakpoint.accessTypes.length > 0 ? (
                <select
                  data-testid={`debug-data-breakpoint-access-${index}`}
                  aria-label={`Access type for ${breakpoint.description}`}
                  className="h-5 max-w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
                  value={breakpoint.accessType ?? ""}
                  onChange={(event) => debug.setDataBreakpointOptions(key, {
                    accessType: event.target.value as DebugDataBreakpoint["accessType"],
                  })}
                >
                  {breakpoint.accessTypes.map((accessType) => (
                    <option key={accessType} value={accessType}>{dataAccessTypeLabel(accessType)}</option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">default</span>
              )}
              <span
                data-testid={`debug-data-breakpoint-scope-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]"
                title={breakpoint.canPersist
                  ? `Saved for ${breakpoint.adapterId} debug sessions`
                  : "Available only in the debug session that created it"}
              >
                {breakpoint.canPersist ? breakpoint.adapterId : "session"}
              </span>
              <button
                type="button"
                data-testid={`debug-data-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingKey(open ? null : key)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-data-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove data breakpoint"
                onClick={() => debug.removeDataBreakpoint(key)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <DataBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                onChange={(options) => debug.setDataBreakpointOptions(key, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DataBreakpointEditor({
  breakpoint,
  index,
  onChange,
}: {
  breakpoint: DebugDataBreakpoint;
  index: number;
  onChange: (options: Partial<DebugDataBreakpoint>) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-data-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-data-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
    </div>
  );
}

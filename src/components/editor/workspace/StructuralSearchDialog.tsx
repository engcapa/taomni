import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { StructuralScope, StructuralSearchSession } from "./useStructuralSearchSession";

const SCOPES: { id: StructuralScope; label: string; needsActiveFile: boolean }[] = [
  { id: "workspace", label: "In Project", needsActiveFile: false },
  { id: "module", label: "Module", needsActiveFile: true },
  { id: "file", label: "Current File", needsActiveFile: true },
];

interface StructuralSearchDialogProps {
  session: StructuralSearchSession;
}

/**
 * ED-PARITY-009 Structural Search dialog (IDEA "Search Structurally…"): Java
 * template editor, per-variable Text modifier, Match case and scope. Find is
 * disabled while the parser backend is unavailable; errors stay in the dialog.
 */
export function StructuralSearchDialog({ session }: StructuralSearchDialogProps) {
  const {
    dialogOpen, draft, setDraft, phase, message, availability, capabilitiesLoaded,
    templateVariables, cancel, find, activeFileAvailable,
  } = session;
  const templateRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [selectedVariable, setSelectedVariable] = useState<string | null>(null);

  useEffect(() => {
    if (!dialogOpen) return;
    // Return focus to the invoker (normally the editor) when the dialog closes.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    templateRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [dialogOpen]);

  // Esc must cancel even after Find disabled the focused button and focus fell
  // back to <body> (a running search is the case users most need to abort).
  useEffect(() => {
    if (!dialogOpen) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [cancel, dialogOpen]);

  useEffect(() => {
    // Find becomes disabled under the pointer while running; keep keyboard
    // focus inside the modal so Esc/Tab stay with it.
    if (phase !== "running") return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [phase]);

  useEffect(() => {
    setSelectedVariable((current) => (
      current && templateVariables.includes(current) ? current : templateVariables[0] ?? null
    ));
  }, [templateVariables]);

  if (!dialogOpen) return null;

  const running = phase === "running";
  const unavailable = phase === "unavailable" || (capabilitiesLoaded && !availability.available);
  const findDisabled = running || unavailable || !draft.pattern.trim();
  const selected = selectedVariable ? draft.variables[selectedVariable] ?? { text: "", invert: false } : null;

  const updateVariable = (name: string, patch: Partial<{ text: string; invert: boolean }>) => {
    setDraft((current) => ({
      ...current,
      variables: {
        ...current.variables,
        [name]: {
          text: patch.text ?? current.variables[name]?.text ?? "",
          invert: patch.invert ?? current.variables[name]?.invert ?? false,
        },
      },
    }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (!findDisabled) void find();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={cancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-testid="structural-search-dialog"
        data-phase={phase}
        role="dialog"
        aria-modal="true"
        aria-label="Structural Search"
        className="flex h-[440px] w-[760px] max-w-[calc(100vw-32px)] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-text)] shadow-xl outline-none"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Structural Search</span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Close Structural Search"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col border-r border-[var(--taomni-code-border)]">
            <div className="flex h-8 shrink-0 items-center gap-2 px-3">
              <label htmlFor="structural-search-template" className="text-[var(--taomni-code-muted)]">Search template:</label>
              <div className="flex-1" />
              <label className="flex items-center gap-1 text-[var(--taomni-code-muted)]">
                Language:
                <select
                  data-testid="structural-search-language"
                  className="taomni-input h-6 px-1 text-[11px]"
                  value="java"
                  onChange={() => undefined}
                >
                  <option value="java">Java</option>
                </select>
              </label>
            </div>
            <textarea
              id="structural-search-template"
              ref={templateRef}
              data-testid="structural-search-template"
              spellCheck={false}
              className="mx-3 min-h-0 flex-1 resize-none rounded border border-[var(--taomni-code-border)] bg-transparent p-2 font-mono text-[12px] outline-none focus:border-[var(--taomni-accent)]"
              value={draft.pattern}
              onChange={(event) => setDraft((current) => ({ ...current, pattern: event.target.value }))}
            />
            <div className="flex h-9 shrink-0 items-center gap-3 px-3">
              <span className="text-[var(--taomni-code-muted)]">Target: <span className="text-[var(--taomni-accent)]">Complete match</span></span>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid="structural-search-match-case"
                  checked={draft.matchCase}
                  onChange={(event) => setDraft((current) => ({ ...current, matchCase: event.target.checked }))}
                />
                Match case
              </label>
            </div>
          </section>
          <aside className="flex w-[240px] shrink-0 flex-col" aria-label="Template variables">
            <div className="h-8 shrink-0 px-3 leading-8 text-[var(--taomni-code-muted)]">Modifiers</div>
            <div className="min-h-0 flex-1 overflow-auto px-2" role="listbox" aria-label="Variables">
              {templateVariables.length === 0 ? (
                <div className="px-1 py-6 text-center text-[var(--taomni-code-muted)]">Nothing to show</div>
              ) : templateVariables.map((name) => {
                const variable = draft.variables[name];
                return (
                  <button
                    key={name}
                    type="button"
                    role="option"
                    aria-selected={selectedVariable === name}
                    data-testid="structural-search-variable-row"
                    data-variable={name}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono ${selectedVariable === name ? "bg-[var(--taomni-code-active-line-bg)]" : "hover:bg-[var(--taomni-code-active-line-bg)]"}`}
                    onClick={() => setSelectedVariable(name)}
                  >
                    <span>${name}$</span>
                    {variable?.text ? (
                      <span className="min-w-0 truncate text-[10px] text-[var(--taomni-code-muted)]">
                        {variable.invert ? "!" : ""}text={variable.text}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {selectedVariable && selected ? (
              <div className="shrink-0 space-y-1.5 border-t border-[var(--taomni-code-border)] p-2">
                <div className="text-[10px] text-[var(--taomni-code-muted)]">Count [1,1] · ${selectedVariable}$</div>
                <label className="flex items-center gap-1.5">
                  <span className="w-9 shrink-0">Text</span>
                  <input
                    data-testid="structural-search-variable-text"
                    aria-label={`Text modifier for $${selectedVariable}$`}
                    className="taomni-input h-6 min-w-0 flex-1 px-1 font-mono text-[11px]"
                    placeholder="regular expression"
                    value={selected.text}
                    onChange={(event) => updateVariable(selectedVariable, { text: event.target.value })}
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    data-testid="structural-search-variable-invert"
                    checked={selected.invert}
                    onChange={(event) => updateVariable(selectedVariable, { invert: event.target.checked })}
                  />
                  Invert condition
                </label>
              </div>
            ) : null}
          </aside>
        </div>
        {unavailable ? (
          <div
            data-testid="structural-search-unavailable"
            role="status"
            className="mx-3 mb-1 flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{message ?? "Structural Search backend is not available"}</span>
          </div>
        ) : phase === "error" && message ? (
          <div data-testid="structural-search-error" role="alert" className="mx-3 mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-600 dark:text-red-400">
            {message}
          </div>
        ) : null}
        <div className="flex h-9 shrink-0 items-center gap-1 border-t border-[var(--taomni-code-border)] px-3" role="radiogroup" aria-label="Search scope">
          {SCOPES.map((scope) => {
            const disabled = scope.needsActiveFile && !activeFileAvailable;
            return (
              <button
                key={scope.id}
                type="button"
                role="radio"
                aria-checked={draft.scope === scope.id}
                data-testid={`structural-search-scope-${scope.id}`}
                disabled={disabled}
                className={`h-6 rounded px-2 disabled:opacity-40 ${draft.scope === scope.id ? "bg-[var(--taomni-code-active-line-bg)] font-medium" : "hover:bg-[var(--taomni-code-active-line-bg)]"}`}
                onClick={() => setDraft((current) => ({ ...current, scope: scope.id }))}
              >
                {scope.label}
              </button>
            );
          })}
          <div className="flex-1" />
          {running ? (
            <span data-testid="structural-search-running" className="mr-2 inline-flex items-center gap-1 text-[var(--taomni-code-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </span>
          ) : null}
          <button
            type="button"
            data-testid="structural-search-find"
            className="h-7 rounded px-3 text-[11px] disabled:opacity-50"
            style={{ background: "var(--taomni-accent)", color: "#fff" }}
            disabled={findDisabled}
            onClick={() => void find()}
          >
            Find
          </button>
          <button
            type="button"
            data-testid="structural-search-cancel"
            className="h-7 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

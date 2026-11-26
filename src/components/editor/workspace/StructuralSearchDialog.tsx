import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { ModalSurface } from "../../ui/ModalSurface";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { StructuralScope, StructuralSearchSession } from "./useStructuralSearchSession";
import {
  EXISTING_JAVA_TEMPLATES,
  STRUCTURAL_FILTER_KINDS,
  UNSUPPORTED_FILTER_REASON,
  readRecentStructuralTemplates,
  recordRecentStructuralTemplate,
} from "./structuralSearchTemplates";

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
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedVariable, setSelectedVariable] = useState<string | null>(null);
  const [recentTemplates, setRecentTemplates] = useState<readonly string[]>([]);
  const [addFilterOpen, setAddFilterOpen] = useState(false);
  const textFilterRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (dialogOpen) setRecentTemplates(readRecentStructuralTemplates());
  }, [dialogOpen]);

  useEffect(() => {
    if (phase !== "running") return;
    const dialog = templateRef.current?.closest("dialog");
    if (dialog && !dialog.contains(document.activeElement)) templateRef.current?.focus();
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

  // DEC-016-01: every run template joins the Recent list.
  const runFind = () => {
    recordRecentStructuralTemplate(draft.pattern);
    void find();
  };
  const loadTemplate = (pattern: string) => {
    setDraft((current) => ({ ...current, pattern, variables: {} }));
    templateRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (!findDisabled) runFind();
    }
  };

  return (
    <ModalSurface
      data-testid="structural-search-dialog"
      data-phase={phase}
      aria-labelledby="structural-search-title"
      aria-describedby={unavailable ? "structural-search-status" : undefined}
      initialFocus='[data-testid="structural-search-template"]'
      onCancel={cancel}
      onKeyDown={onKeyDown}
      className="taomni-modal taomni-workspace-modal"
      data-bleed="true"
      style={{ width: "min(900px, calc(100vw - 32px))", height: "min(460px, calc(100vh - 32px))" }}
    >
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <h2 id="structural-search-title" className="font-medium">Structural Search</h2>
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
          <aside
            data-testid="structural-search-templates"
            aria-label="Templates"
            className="flex w-[190px] shrink-0 flex-col overflow-auto border-r border-[var(--taomni-code-border)] py-1"
          >
            <div className="px-3 py-1 text-ui-caption font-medium uppercase text-[var(--taomni-code-muted)]">Recent</div>
            {recentTemplates.length === 0 ? (
              <div className="px-3 py-1 text-ui-small text-[var(--taomni-code-muted)]">No recent templates</div>
            ) : recentTemplates.map((pattern) => (
              <button
                key={`recent:${pattern}`}
                type="button"
                data-testid="structural-search-template-item"
                data-template-kind="recent"
                title={pattern}
                className="w-full truncate px-3 py-0.5 text-left font-mono text-ui-small hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => loadTemplate(pattern)}
              >
                {pattern}
              </button>
            ))}
            <div className="mt-2 px-3 py-1 text-ui-caption font-medium uppercase text-[var(--taomni-code-muted)]">Existing Templates · Java</div>
            {EXISTING_JAVA_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                data-testid="structural-search-template-item"
                data-template-kind="existing"
                data-template-id={template.id}
                title={template.pattern}
                className="w-full truncate px-3 py-0.5 text-left text-ui-small hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => loadTemplate(template.pattern)}
              >
                {template.label}
              </button>
            ))}
          </aside>
          <section className="flex min-w-0 flex-1 flex-col border-r border-[var(--taomni-code-border)]">
            <div className="flex h-8 shrink-0 items-center gap-2 px-3">
              <label htmlFor="structural-search-template" className="text-[var(--taomni-code-muted)]">Search template:</label>
              <div className="flex-1" />
              <label className="flex items-center gap-1 text-[var(--taomni-code-muted)]">
                Language:
                <select
                  data-testid="structural-search-language"
                  className="taomni-input h-6 px-1 text-ui-small"
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
              className="mx-3 min-h-0 flex-1 resize-none rounded border border-[var(--taomni-code-border)] bg-transparent p-2 font-mono text-ui-body focus-visible:keyboard-outline focus:border-[var(--taomni-accent)]"
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
                      <span className="min-w-0 truncate text-ui-caption text-[var(--taomni-code-muted)]">
                        {variable.invert ? "!" : ""}text={variable.text}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {selectedVariable && selected ? (
              <div className="shrink-0 space-y-1.5 border-t border-[var(--taomni-code-border)] p-2">
                <div className="flex items-center gap-1 text-ui-caption text-[var(--taomni-code-muted)]">
                  <span className="min-w-0 flex-1 truncate">Count [1,1] · ${selectedVariable}$</span>
                  <button
                    type="button"
                    ref={filterButtonRef}
                    data-testid="structural-search-add-filter"
                    aria-haspopup="menu"
                    aria-expanded={addFilterOpen}
                    className="shrink-0 text-[var(--taomni-accent)] hover:underline"
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      setAddFilterOpen((open) => !open);
                    }}
                  >
                    Add filter
                  </button>
                </div>
                {addFilterOpen && (
                  <AnchoredMenu anchor={filterButtonRef} testId="structural-search-filter-menu"
                    ariaLabel="Add filter" onClose={() => setAddFilterOpen(false)} items={[
                      ...STRUCTURAL_FILTER_KINDS.map((kind) => ({
                        label: kind.label,
                        testId: `structural-search-filter-option-${kind.id}`,
                        disabled: !kind.supported,
                        disabledReason: kind.supported ? undefined : UNSUPPORTED_FILTER_REASON,
                        onClick: () => textFilterRef.current?.focus(),
                      })),
                      { label: UNSUPPORTED_FILTER_REASON, testId: "structural-search-filter-reason", sectionHeader: true },
                    ]} />
                )}
                <label className="flex items-center gap-1.5">
                  <span className="w-9 shrink-0">Text</span>
                  <input
                    ref={textFilterRef}
                    data-testid="structural-search-variable-text"
                    aria-label={`Text modifier for $${selectedVariable}$`}
                    className="taomni-input h-6 min-w-0 flex-1 px-1 font-mono text-ui-small"
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
            id="structural-search-status" data-testid="structural-search-unavailable"
            role="status"
            className="mx-3 mb-1 flex items-center gap-1.5 rounded border border-ui-warning-border bg-ui-warning-surface px-2 py-1 text-ui-warning"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{message ?? "Structural Search backend is not available"}</span>
          </div>
        ) : phase === "error" && message ? (
          <div data-testid="structural-search-error" role="alert" className="mx-3 mb-1 rounded border border-ui-danger-border bg-ui-danger-surface px-2 py-1 text-ui-danger">
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
            className="h-7 rounded px-3 text-ui-small disabled:opacity-50"
            style={{ background: "var(--taomni-primary-bg)", color: "var(--taomni-primary-text)" }}
            disabled={findDisabled}
            onClick={runFind}
          >
            Find
          </button>
          <button
            type="button"
            data-testid="structural-search-cancel"
            className="h-7 rounded px-3 text-ui-small hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
    </ModalSurface>
  );
}

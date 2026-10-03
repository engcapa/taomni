import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Download, Loader2, Pencil, Play, Plus, Trash2, Upload, X } from "lucide-react";
import {
  MAIL_FILTER_ACTIONS,
  MAIL_FILTER_FIELDS,
  actionNeeds,
  describeFilter,
  filterOpsFor,
  filterProblem,
  mailExportFilters,
  mailImportFilters,
  mailListFilters,
  mailSaveFilters,
  newMailFilter,
  type MailFilter,
  type MailFilterAction,
  type MailFilterCondition,
  type MailFilterField,
  type MailFilterRunResult,
} from "../../lib/mailFilters";
import { MAIL_TAGS } from "../../lib/mailTags";

export interface MailFiltersPanelProps {
  accountId: string;
  /** Selectable folders (server name + label) for move/copy actions. */
  folders: { name: string; label: string }[];
  /** Folder "Run now" applies to. */
  currentFolder: { name: string; label: string };
  /** Opens the editor on a new filter (e.g. "Create filter from message"). */
  initialDraft?: MailFilter | null;
  onRun: (filterIds: string[] | undefined) => Promise<MailFilterRunResult>;
  onStatus?: (message: string) => void;
  /** Failed actions of the last incoming run (the messages stayed in place). */
  recentErrors?: string[];
}

const inputClass = "h-7 px-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[12px] min-w-0";

function runSummary(result: MailFilterRunResult): string {
  const base = `Filters matched ${result.matched} of ${result.examined} message${result.examined === 1 ? "" : "s"}`;
  const moved = result.moved ? `; moved ${result.moved}` : "";
  const failed = result.errors.length ? `; ${result.errors.length} action${result.errors.length === 1 ? "" : "s"} failed` : "";
  return base + moved + failed;
}

interface EditorProps {
  draft: MailFilter;
  folders: { name: string; label: string }[];
  saving: boolean;
  onChange: (filter: MailFilter) => void;
  onSave: () => void;
  onCancel: () => void;
}

function MailFilterEditor({ draft, folders, saving, onChange, onSave, onCancel }: EditorProps) {
  const problem = filterProblem(draft);
  const setCondition = (index: number, patch: Partial<MailFilterCondition>) => {
    const conditions = draft.conditions.map((condition, i) => {
      if (i !== index) return condition;
      const next = { ...condition, ...patch };
      // Keep the operator valid for the chosen field.
      const ops = filterOpsFor(next.field);
      if (!ops.some((op) => op.value === next.op)) next.op = ops[0].value;
      if (patch.field === "hasAttachment") next.value = "true";
      return next;
    });
    onChange({ ...draft, conditions });
  };
  const setAction = (index: number, patch: Partial<MailFilterAction>) => {
    const actions = draft.actions.map((action, i) => {
      if (i !== index) return action;
      const next = { ...action, ...patch };
      if (patch.kind && actionNeeds(patch.kind) !== actionNeeds(action.kind)) next.value = "";
      return next;
    });
    onChange({ ...draft, actions });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="mail-filter-editor">
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-[12px]">
        <label className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[var(--taomni-text-muted)]">Name</span>
          <input
            className={`${inputClass} flex-1`}
            value={draft.name}
            data-testid="mail-filter-name"
            aria-label="Filter name"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={draft.onIncoming}
              data-testid="mail-filter-on-incoming"
              onChange={(event) => onChange({ ...draft, onIncoming: event.target.checked })}
            />
            Run on new mail (INBOX)
          </label>
          <label className="inline-flex items-center gap-1.5">
            Match
            <select
              className={inputClass}
              value={draft.matchAny ? "any" : "all"}
              data-testid="mail-filter-match"
              aria-label="Match all or any condition"
              onChange={(event) => onChange({ ...draft, matchAny: event.target.value === "any" })}
            >
              <option value="all">all of the conditions</option>
              <option value="any">any of the conditions</option>
            </select>
          </label>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[var(--taomni-text-muted)]">Conditions</legend>
          {draft.conditions.map((condition, index) => (
            <div key={index} className="flex items-center gap-1.5" data-testid="mail-filter-condition">
              <select
                className={inputClass}
                value={condition.field}
                aria-label="Condition field"
                data-testid="mail-filter-condition-field"
                onChange={(event) => setCondition(index, { field: event.target.value as MailFilterField })}
              >
                {MAIL_FILTER_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
              </select>
              <select
                className={inputClass}
                value={condition.op}
                aria-label="Condition operator"
                data-testid="mail-filter-condition-op"
                onChange={(event) => setCondition(index, { op: event.target.value as MailFilterCondition["op"] })}
              >
                {filterOpsFor(condition.field).map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
              </select>
              {condition.field === "tag" ? (
                <select
                  className={`${inputClass} flex-1`}
                  value={condition.value}
                  aria-label="Tag"
                  data-testid="mail-filter-condition-value"
                  onChange={(event) => setCondition(index, { value: event.target.value })}
                >
                  <option value="">Choose a tag…</option>
                  {MAIL_TAGS.map((tag) => <option key={tag.keyword} value={tag.keyword}>{tag.label}</option>)}
                </select>
              ) : condition.field === "hasAttachment" ? (
                <span className="flex-1" />
              ) : (
                <input
                  className={`${inputClass} flex-1`}
                  value={condition.value}
                  inputMode={condition.field === "sizeKb" || condition.field === "ageDays" ? "numeric" : undefined}
                  aria-label="Condition value"
                  data-testid="mail-filter-condition-value"
                  onChange={(event) => setCondition(index, { value: event.target.value })}
                />
              )}
              <button
                type="button"
                className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                title="Remove condition"
                aria-label="Remove condition"
                disabled={draft.conditions.length === 1}
                onClick={() => onChange({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
            data-testid="mail-filter-add-condition"
            onClick={() => onChange({ ...draft, conditions: [...draft.conditions, { field: "subject", op: "contains", value: "" }] })}
          >
            <Plus className="w-3.5 h-3.5" /> Condition
          </button>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[var(--taomni-text-muted)]">Actions</legend>
          {draft.actions.map((action, index) => {
            const needs = actionNeeds(action.kind);
            return (
              <div key={index} className="flex items-center gap-1.5" data-testid="mail-filter-action">
                <select
                  className={inputClass}
                  value={action.kind}
                  aria-label="Action"
                  data-testid="mail-filter-action-kind"
                  onChange={(event) => setAction(index, { kind: event.target.value as MailFilterAction["kind"] })}
                >
                  {MAIL_FILTER_ACTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </select>
                {needs === "folder" && (
                  <select
                    className={`${inputClass} flex-1`}
                    value={action.value ?? ""}
                    aria-label="Target folder"
                    data-testid="mail-filter-action-folder"
                    onChange={(event) => setAction(index, { value: event.target.value })}
                  >
                    <option value="">Choose a folder…</option>
                    {folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.label}</option>)}
                  </select>
                )}
                {needs === "tag" && (
                  <select
                    className={`${inputClass} flex-1`}
                    value={action.value ?? ""}
                    aria-label="Tag to add"
                    data-testid="mail-filter-action-tag"
                    onChange={(event) => setAction(index, { value: event.target.value })}
                  >
                    <option value="">Choose a tag…</option>
                    {MAIL_TAGS.map((tag) => <option key={tag.keyword} value={tag.keyword}>{tag.label}</option>)}
                  </select>
                )}
                {needs === "address" && (
                  <input
                    className={`${inputClass} flex-1`}
                    type="email"
                    value={action.value ?? ""}
                    placeholder="name@example.com"
                    aria-label="Forward to address"
                    data-testid="mail-filter-action-address"
                    onChange={(event) => setAction(index, { value: event.target.value })}
                  />
                )}
                {!needs && <span className="flex-1" />}
                <button
                  type="button"
                  className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                  title="Remove action"
                  aria-label="Remove action"
                  disabled={draft.actions.length === 1}
                  onClick={() => onChange({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
            data-testid="mail-filter-add-action"
            onClick={() => onChange({ ...draft, actions: [...draft.actions, { kind: "markRead" }] })}
          >
            <Plus className="w-3.5 h-3.5" /> Action
          </button>
        </fieldset>
        <p className="text-[11px] text-[var(--taomni-text-muted)]">
          New mail is filtered while this tab is open. Body conditions on mail whose body is not cached are checked with a server search.
        </p>
      </div>
      <div className="h-11 shrink-0 px-3 flex items-center gap-2 border-t border-[var(--taomni-divider)] text-[12px]">
        {problem && <span className="min-w-0 truncate text-[var(--taomni-text-muted)]" data-testid="mail-filter-problem">{problem}</span>}
        <span className="flex-1" />
        <button type="button" className="taomni-btn h-7 px-3" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="taomni-btn h-7 px-3 inline-flex items-center gap-1 text-[var(--taomni-accent)]"
          data-testid="mail-filter-save"
          disabled={!!problem || saving}
          onClick={onSave}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save filter
        </button>
      </div>
    </div>
  );
}

export function MailFiltersPanel({ accountId, folders, currentFolder, initialDraft, onRun, onStatus, recentErrors = [] }: MailFiltersPanelProps) {
  const [filters, setFilters] = useState<MailFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MailFilter | null>(initialDraft ?? null);
  const [lastRun, setLastRun] = useState<MailFilterRunResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    mailListFilters(accountId)
      .then((list) => {
        if (!cancelled) setFilters(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (initialDraft) setDraft(initialDraft);
  }, [initialDraft]);

  const persist = useCallback(async (next: MailFilter[]) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await mailSaveFilters(accountId, next);
      setFilters(saved);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [accountId]);

  const saveDraft = async () => {
    if (!draft) return;
    const exists = filters.some((filter) => filter.id === draft.id);
    const next = exists ? filters.map((filter) => (filter.id === draft.id ? draft : filter)) : [...filters, draft];
    if (await persist(next)) {
      onStatus?.(`Saved filter "${draft.name.trim()}"`);
      setDraft(null);
    }
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= filters.length) return;
    const next = [...filters];
    [next[index], next[target]] = [next[target], next[index]];
    void persist(next);
  };

  const run = async (filterIds?: string[]) => {
    setRunning(filterIds?.[0] ?? "all");
    setError(null);
    try {
      const result = await onRun(filterIds);
      setLastRun(result);
      onStatus?.(runSummary(result));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  };

  const exportFilters = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ title: "Export mail filters", defaultPath: "mail-filters.json" });
      if (typeof path !== "string" || !path.trim()) return;
      const count = await mailExportFilters(accountId, path);
      onStatus?.(`Exported ${count} filter${count === 1 ? "" : "s"} to ${path}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const importFilters = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ title: "Import mail filters", multiple: false, filters: [{ name: "Filters", extensions: ["json"] }] });
      if (typeof path !== "string" || !path.trim()) return;
      const before = filters.length;
      const list = await mailImportFilters(accountId, path);
      setFilters(list);
      const added = list.length - before;
      onStatus?.(`Imported ${added} filter${added === 1 ? "" : "s"}`);
    } catch (e) {
      setError(String(e));
    }
  };

  if (draft) {
    return (
      <MailFilterEditor
        draft={draft}
        folders={folders}
        saving={saving}
        onChange={setDraft}
        onSave={() => void saveDraft()}
        onCancel={() => setDraft(null)}
      />
    );
  }

  const iconButton = "taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center";
  return (
    <div className="flex-1 min-h-0 flex flex-col text-[12px]" data-testid="mail-filters-panel">
      <div className="h-9 shrink-0 px-3 flex items-center gap-1.5 border-b border-[var(--taomni-divider)]">
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          data-testid="mail-filter-new"
          onClick={() => setDraft(newMailFilter())}
        >
          <Plus className="w-3.5 h-3.5" /> New filter
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          data-testid="mail-filter-run-all"
          title={`Run every enabled filter on ${currentFolder.label}`}
          disabled={filters.length === 0 || running !== null}
          onClick={() => void run(undefined)}
        >
          {running === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Run on {currentFolder.label}
        </button>
        <span className="flex-1" />
        <button type="button" className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center" title="Import filters" aria-label="Import filters" onClick={() => void importFilters()}>
          <Upload className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center" title="Export filters" aria-label="Export filters" disabled={filters.length === 0} onClick={() => void exportFilters()}>
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && <div className="px-3 py-1.5 text-red-500 border-b border-[var(--taomni-divider)]" data-testid="mail-filters-error">{error}</div>}
      {recentErrors.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--taomni-divider)]" data-testid="mail-filters-recent-errors">
          <div className="text-[var(--taomni-text-muted)]">Last run on new mail: these actions failed and the messages stayed where they were.</div>
          {recentErrors.map((message) => <div key={message} className="text-red-500">{message}</div>)}
        </div>
      )}
      {lastRun && (
        <div className="px-3 py-1.5 border-b border-[var(--taomni-divider)] text-[var(--taomni-text-muted)]" data-testid="mail-filters-last-run">
          {runSummary(lastRun)}
          {lastRun.errors.map((message) => <div key={message} className="text-red-500">{message}</div>)}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {loading ? (
          <div className="p-3 flex items-center gap-2 text-[var(--taomni-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading filters…</div>
        ) : filters.length === 0 ? (
          <div className="p-3 text-[var(--taomni-text-muted)]" data-testid="mail-filters-empty">
            No filters yet. Create one here or from a message context menu.
          </div>
        ) : filters.map((filter, index) => (
          <div
            key={filter.id}
            className="px-2 py-1.5 flex items-center gap-2 rounded hover:bg-[var(--taomni-hover)]"
            data-testid="mail-filter-row"
            data-filter-name={filter.name}
            data-enabled={filter.enabled ? "true" : "false"}
          >
            <input
              type="checkbox"
              checked={filter.enabled}
              aria-label={`Enable ${filter.name}`}
              data-testid="mail-filter-enabled"
              disabled={saving}
              onChange={(event) => void persist(filters.map((f) => (f.id === filter.id ? { ...f, enabled: event.target.checked } : f)))}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{filter.name}{filter.onIncoming ? "" : " (manual only)"}</div>
              <div className="truncate text-[11px] text-[var(--taomni-text-muted)]" title={describeFilter(filter)}>{describeFilter(filter)}</div>
            </div>
            <button type="button" className={iconButton} title="Move up" aria-label={`Move ${filter.name} up`} disabled={index === 0 || saving} onClick={() => move(index, -1)}>
              <ArrowUp className="w-3 h-3" />
            </button>
            <button type="button" className={iconButton} title="Move down" aria-label={`Move ${filter.name} down`} disabled={index === filters.length - 1 || saving} onClick={() => move(index, 1)}>
              <ArrowDown className="w-3 h-3" />
            </button>
            <button type="button" className={iconButton} title={`Run on ${currentFolder.label}`} aria-label={`Run ${filter.name}`} data-testid="mail-filter-run" disabled={running !== null} onClick={() => void run([filter.id])}>
              {running === filter.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            </button>
            <button type="button" className={iconButton} title="Edit" aria-label={`Edit ${filter.name}`} data-testid="mail-filter-edit" onClick={() => setDraft(filter)}>
              <Pencil className="w-3 h-3" />
            </button>
            <button type="button" className={iconButton} title="Delete" aria-label={`Delete ${filter.name}`} data-testid="mail-filter-delete" disabled={saving} onClick={() => void persist(filters.filter((f) => f.id !== filter.id))}>
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

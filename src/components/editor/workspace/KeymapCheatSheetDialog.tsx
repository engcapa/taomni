import { Fragment, useId, useMemo, useState } from "react";
import { Keyboard, Search, TriangleAlert, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { ModalSurface } from "../../ui/ModalSurface";
import { useT } from "../../../lib/i18n";
import type { ActionSnapshotItem } from "./workspaceActionHost";

export interface KeymapCheatSheetDialogProps {
  open: boolean;
  onClose: () => void;
  onExecuteCommand?: (commandId: string) => void | Promise<unknown>;
  /**
   * Instance-scoped host snapshot (§8.17.3): the ONLY keymap input. Rows keep
   * their frozen evaluations so execution can reuse the rendered state.
   */
  actionSnapshots: ActionSnapshotItem[];
}

export function KeymapCheatSheetDialog({
  open,
  onClose,
  onExecuteCommand,
  actionSnapshots,
}: KeymapCheatSheetDialogProps) {
  const t = useT();
  const titleId = useId();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const boundCommands = useMemo(
    () => actionSnapshots
      .filter((entry) => entry.state.availability !== "unsupported")
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        category: entry.category,
        keybinding: entry.keybinding,
        keybindings: entry.keybindings,
        // ED-PARITY-004 DEC-05/§8: conflict ownership must be visible on the
        // main display surface, and an action that just LOST a reassigned
        // chord keeps its row instead of silently dropping out of the list.
        bindingConflicts: entry.bindingConflicts,
        keywords: entry.keywords,
        provenance: entry.state.source,
        enabled: entry.state.availability === "available",
        evaluation: entry.evaluation,
      }))
      .filter((command) => !!command.keybinding
        || (command.keybindings?.length ?? 0) > 0
        || (command.bindingConflicts?.length ?? 0) > 0),
    [actionSnapshots],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of boundCommands) {
      if (c.category) set.add(c.category);
    }
    return ["All", ...Array.from(set).sort()];
  }, [boundCommands]);

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return boundCommands.filter((c) => {
      if (selectedCategory !== "All" && c.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      const matchTitle = c.title.toLowerCase().includes(q);
      const matchCategory = c.category.toLowerCase().includes(q);
      const matchId = c.id.toLowerCase().includes(q);
      const matchKeywords = c.keywords?.some((k) => k.toLowerCase().includes(q));
      const allBindings = [c.keybinding, ...(c.keybindings ?? [])].filter(Boolean).join(" ").toLowerCase();
      return matchTitle || matchCategory || matchId || Boolean(matchKeywords) || allBindings.includes(q);
    });
  }, [boundCommands, search, selectedCategory]);

  if (!open) return null;

  return (
    <ModalSurface
      initialFocus='[data-testid="keymap-search-input"]'
      onCancel={onClose}
      aria-labelledby={titleId}
      data-testid="keymap-cheatsheet-dialog"
      className="taomni-modal h-[80vh] !w-[min(56rem,calc(100vw-32px))] !gap-0 !p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--taomni-divider)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Keyboard className="h-5 w-5 text-ui-info" />
          <div>
            <h2 id={titleId} className="text-ui-title font-semibold">
              {t("keymapReference.title")}
            </h2>
            <p className="text-ui-small text-[var(--taomni-text-muted)] mt-0.5">
              {t("keymapReference.count", { count: boundCommands.length })}
            </p>
          </div>
        </div>
        <IconButton
          data-testid="keymap-cheatsheet-close"
          onClick={onClose}
          labelKey="close"
          className="rounded p-1 text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
        >
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {/* Toolbar & Search */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-hover)]/30 px-4 py-2 text-ui-small">
        {/* Category Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              data-testid={`keymap-category-${category}`}
              aria-pressed={selectedCategory === category}
              onClick={() => setSelectedCategory(category)}
              className={`rounded-full px-2.5 py-0.5 transition-colors ${
                selectedCategory === category
                  ? "bg-[var(--taomni-selected)] text-[var(--taomni-text)] font-semibold border border-[var(--taomni-selected-border)]"
                  : "text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
            >
              {category === "All" ? t("keymapReference.all") : category}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative flex max-w-full items-center">
          <Search className="absolute left-2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            type="text"
            data-testid="keymap-search-input"
            aria-label={t("keymapReference.search")}
            placeholder={t("keymapReference.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-60 max-w-full rounded border border-[var(--taomni-divider)] bg-[var(--taomni-input-bg)] pl-7 pr-2 text-ui-small text-[var(--taomni-text)] placeholder:text-[var(--taomni-text-muted)] focus-visible:keyboard-outline"
          />
        </div>
      </div>

      {/* Table Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 divide-y divide-[var(--taomni-divider)]/40">
        {filteredCommands.length === 0 ? (
          <div className="p-8 text-center text-[var(--taomni-text-muted)]">
            {t("keymapReference.empty", { search })}
          </div>
        ) : (
          filteredCommands.map((command) => {
            const bindings = Array.from(new Set([command.keybinding, ...(command.keybindings ?? [])]
              .filter((label): label is string => Boolean(label))));
            const provenance = command.provenance;
            return (
              <div
                key={command.id}
                data-testid={`keymap-item-${command.id}`}
                className="group flex items-center justify-between py-2 px-2 rounded hover:bg-[var(--taomni-hover)]/50 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0 pr-4">
                  <span className="rounded bg-[var(--taomni-hover)] px-1.5 py-0.5 text-ui-caption text-[var(--taomni-text-muted)] shrink-0 font-medium">
                    {command.category}
                  </span>
                  {provenance && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-ui-caption font-medium shrink-0 ${
                        provenance === "local"
                          ? "bg-ui-success-surface text-ui-success border border-ui-success-border"
                          : provenance === "provider"
                            ? "bg-ui-info-surface text-ui-info border border-ui-info-border"
                            : provenance === "index"
                              ? "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text)] border border-[var(--taomni-divider)]"
                              : "bg-ui-warning-surface text-ui-warning border border-ui-warning-border"
                      }`}
                    >
                      {t(`keymapReference.${provenance === "provider" ? "provider" : provenance === "local" ? "local" : provenance === "index" ? "index" : "partial"}`)}
                    </span>
                  )}
                  <div className="min-w-0 truncate">
                    <span className="font-medium text-ui-body">{command.title}</span>
                    <span className="ml-2 font-mono text-ui-caption text-[var(--taomni-text-muted)]">
                      {command.id}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1.5">
                    {bindings.map((binding, index) => (
                      <Fragment key={binding}>
                        {index > 0 && <span className="text-ui-caption text-[var(--taomni-text-muted)]">{t("keymapReference.or")}</span>}
                        <kbd className="whitespace-nowrap rounded border border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] px-1.5 py-0.5 font-mono text-ui-caption font-semibold">
                          {binding}
                        </kbd>
                      </Fragment>
                    ))}
                    {bindings.length === 0 && (
                      <span className="text-ui-caption text-[var(--taomni-text-muted)]">{t("keymapReference.unbound")}</span>
                    )}
                    {(command.bindingConflicts?.length ?? 0) > 0 && (
                      <span
                        data-testid={`keymap-conflict-${command.id}`}
                        role="img"
                        aria-label={t("keymapReference.conflict", { actions: command.bindingConflicts!.flatMap((entry) => entry.actionIds).join(", ") })}
                        className="text-ui-warning"
                      >
                        <TriangleAlert aria-hidden="true" className="size-4" />
                      </span>
                    )}
                  </div>

                  {onExecuteCommand && command.enabled && (
                    <button
                      type="button"
                      data-testid={`keymap-run-${command.id}`}
                      onClick={() => {
                        onClose();
                        onExecuteCommand(command.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded px-2 py-0.5 text-ui-caption font-medium bg-ui-info-surface text-ui-info hover:bg-[var(--taomni-hover)] transition-opacity"
                    >
                      {t("keymapReference.run")}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end border-t border-[var(--taomni-divider)] bg-[var(--taomni-hover)]/20 px-4 py-2.5 text-ui-small text-[var(--taomni-text-muted)]">
        <button
          type="button"
          data-testid="keymap-cheatsheet-footer-close"
          onClick={onClose}
          className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-input-bg)] px-3 py-1 text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
        >
          {t("common.close")}
        </button>
      </div>
    </ModalSurface>
  );
}

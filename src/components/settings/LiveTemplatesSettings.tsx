import { useEffect, useMemo, useState } from "react";
import { FileCode2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  DEFAULT_LIVE_TEMPLATE_PREFERENCES,
  LIVE_TEMPLATE_LANGUAGE_OPTIONS,
  createCustomLiveTemplateId,
  loadLiveTemplatePreferences,
  normalizeCustomLiveTemplate,
  saveLiveTemplatePreferences,
  setBuiltinTemplateEnabled,
  subscribeLiveTemplatePreferences,
  type CustomLiveTemplate,
  type LiveTemplateLanguage,
  type LiveTemplatePreferences,
} from "../../lib/liveTemplatePreferences";
import {
  listBuiltinTemplatesForSettings,
  refreshLiveTemplatePreferencesCache,
} from "../editor/workspace/liveTemplates";

type LanguageFilter = "all" | LiveTemplateLanguage;
type KindFilter = "all" | "live" | "postfix";

function languageLabel(lang: LiveTemplateLanguage): string {
  switch (lang) {
    case "javascript": return "JavaScript";
    case "typescript": return "TypeScript";
    case "csharp": return "C#";
    case "generic": return "Generic";
    default: return lang.charAt(0).toUpperCase() + lang.slice(1);
  }
}

function emptyCustomDraft(): CustomLiveTemplate {
  return {
    id: createCustomLiveTemplateId(),
    abbreviation: "",
    body: "",
    description: "",
    languages: ["java"],
    postfix: false,
    enabled: true,
  };
}

export function LiveTemplatesSettings() {
  const t = useT();
  const [preferences, setPreferences] = useState(loadLiveTemplatePreferences);
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>("java");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomLiveTemplate | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(
    () => subscribeLiveTemplatePreferences((next) => {
      setPreferences(next);
      refreshLiveTemplatePreferencesCache(next);
    }),
    [],
  );

  const persist = (next: LiveTemplatePreferences) => {
    const saved = {
      ...next,
      customTemplates: next.customTemplates.slice(),
    };
    setPreferences(saved);
    saveLiveTemplatePreferences(saved);
    refreshLiveTemplatePreferencesCache(saved);
  };

  const builtins = useMemo(
    () => listBuiltinTemplatesForSettings(preferences),
    [preferences],
  );

  const filteredBuiltins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return builtins.filter((item) => {
      if (languageFilter !== "all" && !item.languages.includes(languageFilter)) return false;
      if (kindFilter === "live" && item.postfix) return false;
      if (kindFilter === "postfix" && !item.postfix) return false;
      if (!q) return true;
      return item.abbreviation.toLowerCase().includes(q)
        || item.description.toLowerCase().includes(q)
        || item.body.toLowerCase().includes(q);
    });
  }, [builtins, languageFilter, kindFilter, query]);

  const filteredCustom = useMemo(() => {
    const q = query.trim().toLowerCase();
    return preferences.customTemplates.filter((item) => {
      if (languageFilter !== "all" && !item.languages.includes(languageFilter)) return false;
      if (kindFilter === "live" && item.postfix) return false;
      if (kindFilter === "postfix" && !item.postfix) return false;
      if (!q) return true;
      return item.abbreviation.toLowerCase().includes(q)
        || item.description.toLowerCase().includes(q)
        || item.body.toLowerCase().includes(q);
    });
  }, [preferences.customTemplates, languageFilter, kindFilter, query]);

  const enabledBuiltinCount = builtins.filter((item) => item.enabled).length;

  const startAddCustom = () => {
    const next = emptyCustomDraft();
    if (languageFilter !== "all") next.languages = [languageFilter];
    setDraft(next);
    setEditingCustomId(next.id);
    setFormError(null);
  };

  const startEditCustom = (item: CustomLiveTemplate) => {
    setDraft({ ...item, languages: [...item.languages] });
    setEditingCustomId(item.id);
    setFormError(null);
  };

  const cancelEdit = () => {
    setDraft(null);
    setEditingCustomId(null);
    setFormError(null);
  };

  const saveDraft = () => {
    if (!draft) return;
    const normalized = normalizeCustomLiveTemplate(draft);
    if (!normalized) {
      setFormError(t("settings.liveTemplatesFormInvalid"));
      return;
    }
    const others = preferences.customTemplates.filter((item) => item.id !== normalized.id);
    persist({
      ...preferences,
      customTemplates: [...others, normalized],
    });
    cancelEdit();
  };

  const removeCustom = (id: string) => {
    persist({
      ...preferences,
      customTemplates: preferences.customTemplates.filter((item) => item.id !== id),
    });
    if (editingCustomId === id) cancelEdit();
  };

  const toggleCustomEnabled = (id: string, enabled: boolean) => {
    persist({
      ...preferences,
      customTemplates: preferences.customTemplates.map((item) => (
        item.id === id ? { ...item, enabled } : item
      )),
    });
  };

  return (
    <section
      data-testid="live-templates-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex items-center gap-3">
        <FileCode2 className="h-4 w-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{t("settings.liveTemplatesTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.liveTemplatesSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="live-templates-reset"
          className="taomni-btn ml-auto h-7 px-2.5 inline-flex shrink-0 items-center gap-1 text-[11px]"
          onClick={() => {
            cancelEdit();
            persist({ ...DEFAULT_LIVE_TEMPLATE_PREFERENCES, customTemplates: [] });
          }}
          title={t("settings.liveTemplatesResetTitle")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("settings.reset")}
        </button>
      </div>

      <div className="space-y-3 border-t border-[var(--taomni-divider)] pt-3">
        <label className="flex items-start gap-2 text-[12px]">
          <input
            data-testid="live-templates-enabled"
            className="taomni-checkbox mt-0.5"
            type="checkbox"
            checked={preferences.enabled}
            onChange={(event) => persist({ ...preferences, enabled: event.target.checked })}
          />
          <span>
            <span className="block font-medium">{t("settings.liveTemplatesEnabled")}</span>
            <span className="block text-[11px] text-[var(--taomni-text-muted)]">
              {t("settings.liveTemplatesEnabledHint")}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[12px]">
          <input
            data-testid="live-templates-postfix-enabled"
            className="taomni-checkbox mt-0.5"
            type="checkbox"
            checked={preferences.postfixEnabled}
            disabled={!preferences.enabled}
            onChange={(event) => persist({ ...preferences, postfixEnabled: event.target.checked })}
          />
          <span>
            <span className="block font-medium">{t("settings.liveTemplatesPostfixEnabled")}</span>
            <span className="block text-[11px] text-[var(--taomni-text-muted)]">
              {t("settings.liveTemplatesPostfixEnabledHint")}
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] text-[var(--taomni-text-muted)]" htmlFor="live-templates-lang">
              {t("settings.liveTemplatesLanguageFilter")}
            </label>
            <select
              id="live-templates-lang"
              data-testid="live-templates-language-filter"
              className="taomni-input h-8 min-w-[8rem] text-[12px]"
              value={languageFilter}
              onChange={(event) => setLanguageFilter(event.target.value as LanguageFilter)}
            >
              <option value="all">{t("settings.liveTemplatesLanguageAll")}</option>
              {LIVE_TEMPLATE_LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang} value={lang}>{languageLabel(lang)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--taomni-text-muted)]" htmlFor="live-templates-kind">
              {t("settings.liveTemplatesKindFilter")}
            </label>
            <select
              id="live-templates-kind"
              data-testid="live-templates-kind-filter"
              className="taomni-input h-8 min-w-[8rem] text-[12px]"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as KindFilter)}
            >
              <option value="all">{t("settings.liveTemplatesKindAll")}</option>
              <option value="live">{t("settings.liveTemplatesKindLive")}</option>
              <option value="postfix">{t("settings.liveTemplatesKindPostfix")}</option>
            </select>
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="mb-1 block text-[11px] text-[var(--taomni-text-muted)]" htmlFor="live-templates-search">
              {t("settings.liveTemplatesSearch")}
            </label>
            <input
              id="live-templates-search"
              data-testid="live-templates-search"
              className="taomni-input h-8 w-full text-[12px]"
              value={query}
              placeholder={t("settings.liveTemplatesSearchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <div className="text-[11px] text-[var(--taomni-text-muted)]" data-testid="live-templates-builtin-summary">
          {t("settings.liveTemplatesBuiltinSummary")
            .replace("{enabled}", String(enabledBuiltinCount))
            .replace("{total}", String(builtins.length))
            .replace("{shown}", String(filteredBuiltins.length))}
        </div>

        <div
          data-testid="live-templates-builtin-list"
          className="max-h-72 overflow-auto rounded border border-[var(--taomni-divider)]"
        >
          {filteredBuiltins.length === 0 ? (
            <div className="px-3 py-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
              {t("settings.liveTemplatesEmptyFilter")}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--taomni-divider)]">
              {filteredBuiltins.map((item) => (
                <li
                  key={item.key}
                  className="flex items-start gap-2 px-2 py-2 text-[12px]"
                  data-testid={`live-template-builtin-${item.key}`}
                >
                  <input
                    type="checkbox"
                    className="taomni-checkbox mt-0.5"
                    data-testid={`live-template-builtin-enabled-${item.key}`}
                    checked={item.enabled}
                    disabled={!preferences.enabled || (item.postfix && !preferences.postfixEnabled)}
                    onChange={(event) => {
                      persist(setBuiltinTemplateEnabled(preferences, item.key, event.target.checked));
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="rounded bg-[var(--taomni-surface-2,transparent)] px-1 font-mono text-[12px] font-semibold">
                        {item.abbreviation}
                      </code>
                      <span className="rounded border border-[var(--taomni-divider)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
                        {item.postfix
                          ? t("settings.liveTemplatesKindPostfix")
                          : t("settings.liveTemplatesKindLive")}
                      </span>
                      <span className="text-[10px] text-[var(--taomni-text-muted)]">
                        {item.languages.map(languageLabel).join(", ")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--taomni-text-muted)]">
                      {item.description}
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-[var(--taomni-code-gutter-bg,rgba(0,0,0,0.15))] px-1.5 py-1 font-mono text-[10px] leading-snug text-[var(--taomni-text-muted)]">
                      {item.body}
                    </pre>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <div className="text-[12px] font-medium">{t("settings.liveTemplatesCustomHeading")}</div>
          <button
            type="button"
            data-testid="live-templates-add-custom"
            className="taomni-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
            onClick={startAddCustom}
            disabled={!preferences.enabled}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.liveTemplatesAddCustom")}
          </button>
        </div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {t("settings.liveTemplatesCustomHint")}
        </div>

        {draft && (
          <div
            data-testid="live-templates-custom-form"
            className="space-y-2 rounded border border-[var(--taomni-accent)]/40 bg-[var(--taomni-surface-2,transparent)] p-3"
          >
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium" htmlFor="live-template-abbr">
                  {t("settings.liveTemplatesAbbreviation")}
                </label>
                <input
                  id="live-template-abbr"
                  data-testid="live-template-custom-abbreviation"
                  className="taomni-input h-8 w-full font-mono text-[12px]"
                  value={draft.abbreviation}
                  onChange={(event) => setDraft({ ...draft, abbreviation: event.target.value })}
                  placeholder="sout"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium" htmlFor="live-template-desc">
                  {t("settings.liveTemplatesDescription")}
                </label>
                <input
                  id="live-template-desc"
                  data-testid="live-template-custom-description"
                  className="taomni-input h-8 w-full text-[12px]"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium" htmlFor="live-template-body">
                {t("settings.liveTemplatesBody")}
              </label>
              <textarea
                id="live-template-body"
                data-testid="live-template-custom-body"
                className="taomni-input min-h-[5rem] w-full font-mono text-[12px]"
                value={draft.body}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                placeholder={'System.out.println(${});'}
              />
              <div className="mt-1 text-[10px] text-[var(--taomni-text-muted)]">
                {t("settings.liveTemplatesBodyHint")}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  className="taomni-checkbox"
                  data-testid="live-template-custom-postfix"
                  checked={draft.postfix}
                  onChange={(event) => setDraft({ ...draft, postfix: event.target.checked })}
                />
                {t("settings.liveTemplatesKindPostfix")}
              </label>
              <label className="flex items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  className="taomni-checkbox"
                  data-testid="live-template-custom-enabled"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                {t("settings.liveTemplatesCustomEnabled")}
              </label>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium">{t("settings.liveTemplatesLanguages")}</div>
              <div className="flex flex-wrap gap-2" data-testid="live-template-custom-languages">
                {LIVE_TEMPLATE_LANGUAGE_OPTIONS.filter((lang) => lang !== "generic").map((lang) => {
                  const checked = draft.languages.includes(lang);
                  return (
                    <label key={lang} className="flex items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        className="taomni-checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const languages = event.target.checked
                            ? [...draft.languages, lang]
                            : draft.languages.filter((item) => item !== lang);
                          setDraft({
                            ...draft,
                            languages: languages.length ? languages : [lang],
                          });
                        }}
                      />
                      {languageLabel(lang)}
                    </label>
                  );
                })}
              </div>
            </div>
            {formError && (
              <div className="text-[11px] text-red-500" data-testid="live-template-custom-error">
                {formError}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="live-template-custom-save"
                className="taomni-btn-primary h-7 px-3 text-[11px]"
                onClick={saveDraft}
              >
                {t("settings.liveTemplatesSave")}
              </button>
              <button
                type="button"
                data-testid="live-template-custom-cancel"
                className="taomni-btn h-7 px-3 text-[11px]"
                onClick={cancelEdit}
              >
                {t("settings.liveTemplatesCancel")}
              </button>
            </div>
          </div>
        )}

        <div
          data-testid="live-templates-custom-list"
          className="rounded border border-[var(--taomni-divider)]"
        >
          {filteredCustom.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--taomni-text-muted)]">
              {t("settings.liveTemplatesCustomEmpty")}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--taomni-divider)]">
              {filteredCustom.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2 px-2 py-2 text-[12px]"
                  data-testid={`live-template-custom-${item.id}`}
                >
                  <input
                    type="checkbox"
                    className="taomni-checkbox mt-0.5"
                    data-testid={`live-template-custom-enabled-${item.id}`}
                    checked={item.enabled}
                    disabled={!preferences.enabled || (item.postfix && !preferences.postfixEnabled)}
                    onChange={(event) => toggleCustomEnabled(item.id, event.target.checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono font-semibold">{item.abbreviation}</code>
                      <span className="text-[10px] text-[var(--taomni-text-muted)]">
                        {item.postfix
                          ? t("settings.liveTemplatesKindPostfix")
                          : t("settings.liveTemplatesKindLive")}
                        {" · "}
                        {item.languages.map(languageLabel).join(", ")}
                      </span>
                    </div>
                    {item.description && (
                      <div className="text-[11px] text-[var(--taomni-text-muted)]">{item.description}</div>
                    )}
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--taomni-text-muted)]">
                      {item.body}
                    </pre>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="taomni-btn h-7 px-2 text-[11px]"
                      data-testid={`live-template-custom-edit-${item.id}`}
                      onClick={() => startEditCustom(item)}
                    >
                      {t("settings.liveTemplatesEdit")}
                    </button>
                    <button
                      type="button"
                      className="taomni-btn h-7 px-2 text-[11px] text-red-500"
                      data-testid={`live-template-custom-delete-${item.id}`}
                      onClick={() => removeCustom(item.id)}
                      title={t("settings.liveTemplatesDelete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

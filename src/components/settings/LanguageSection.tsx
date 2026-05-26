import { LOCALES, useLocale, useT } from "../../lib/i18n";

// In-Settings language picker. Mirrors the title-bar quick switcher, but
// presents the choices as radio buttons so users discovering the setting
// from Settings can see all available locales at a glance and add new
// ones later by extending the LOCALES list.
export function LanguageSection() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const current = LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0];

  return (
    <section
      data-testid="settings-language-section"
      className="mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3"
    >
      <div className="mb-2 flex items-center gap-3">
        <div>
          <div className="text-[14px] font-semibold">{t("settings.languageTitle")}</div>
          <div className="text-[12px] text-[var(--moba-text-muted)]">
            {t("settings.languageCurrent", { label: current.nativeLabel })}
          </div>
        </div>
      </div>
      <div role="radiogroup" aria-label={t("language.pickerTitle")} className="flex flex-wrap gap-2 mt-1">
        {LOCALES.map((entry) => {
          const active = entry.code === locale;
          return (
            <button
              key={entry.code}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`settings-language-${entry.code}`}
              data-active={active || undefined}
              onClick={() => setLocale(entry.code)}
              className="moba-btn h-8 px-3 inline-flex items-center gap-1.5 text-[12px]"
              style={
                active
                  ? { background: "var(--moba-selected)", outline: "1px solid var(--moba-accent)" }
                  : undefined
              }
            >
              <span className="font-semibold">{entry.nativeLabel}</span>
              <span className="text-[var(--moba-text-muted)]">· {entry.englishLabel}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

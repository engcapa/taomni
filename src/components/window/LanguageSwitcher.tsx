import { Languages } from "lucide-react";
import { useContextMenu } from "../ContextMenu";
import { LOCALES, useLocale, useT } from "../../lib/i18n";

// Compact globe-style toggle that opens a context menu listing every locale.
// The same component is used by both the regular and compact title bars so
// the language switch is always anchored to the top-right area.
export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const ctx = useContextMenu();

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    ctx.showAt(
      rect.right - 180,
      rect.bottom,
      LOCALES.map((entry) => ({
        label: entry.nativeLabel,
        testId: `language-option-${entry.code}`,
        checked: entry.code === locale,
        onClick: () => setLocale(entry.code),
      })),
    );
  };

  // Tooltip mentions the next locale to make the action discoverable even
  // before opening the menu — mirrors the theme cycle pattern.
  const currentEntry = LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0];
  const nextEntry =
    LOCALES[(LOCALES.indexOf(currentEntry) + 1) % LOCALES.length] ?? LOCALES[0];
  const title = t("language.cycleTitle", {
    label: currentEntry.nativeLabel,
    next: nextEntry.nativeLabel,
  });

  return (
    <>
      {ctx.render}
      <button
        type="button"
        data-testid="language-switcher"
        title={title}
        aria-label={t("language.ariaLabel")}
        className="taomni-titlebar-tray-btn h-full w-12 inline-flex items-center justify-center gap-1 hover:bg-[var(--taomni-hover)]"
        style={{ color: "var(--taomni-text)" }}
        onClick={openMenu}
      >
        <Languages className="w-[16px] h-[16px]" />
        <span
          className="text-[10px] font-semibold uppercase tracking-wide"
          aria-hidden="true"
        >
          {locale === "en" ? "EN" : "中"}
        </span>
      </button>
    </>
  );
}

import { Languages } from "lucide-react";
import { useContextMenu } from "../ContextMenu";
import { LOCALES, useLocale, useT } from "../../lib/i18n";

// Compact globe-style toggle that opens a context menu listing every locale.
// The `rail` variant is used by the primary navigation rail's bottom global
// tools group (v6.1 AC-04); the titlebar variants are kept for detached
// windows, which have no rail.
export function LanguageSwitcher({ variant = "titlebar" }: { variant?: "titlebar" | "rail" } = {}) {
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
        className={variant === "rail"
          ? "relative flex min-h-[32px] w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-0 py-1 hover:bg-[var(--taomni-hover)]"
          : "taomni-titlebar-tray-btn h-full w-12 inline-flex items-center justify-center gap-1 hover:bg-[var(--taomni-hover)]"}
        style={{ color: "var(--taomni-text)" }}
        onClick={openMenu}
      >
        <Languages className={variant === "rail" ? "w-[16px] h-[16px]" : "w-[16px] h-[16px]"} />
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

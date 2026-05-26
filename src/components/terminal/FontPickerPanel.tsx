import { useMemo, useState, useEffect, useRef } from "react";
import { Search, Check, X } from "lucide-react";
import { isMonospaceFont } from "../../lib/systemFonts";
import { useT } from "../../lib/i18n";

interface FontPickerPanelProps {
  fonts: string[];
  selectedFont: string; // The primary name of the currently selected font
  onSelect: (font: string) => void;
}

export function FontPickerPanel({ fonts, selectedFont, onSelect }: FontPickerPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  // Focus search input when the panel opens/mounts
  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, []);

  const filteredFonts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return fonts;
    return fonts.filter((font) => font.toLowerCase().includes(query));
  }, [fonts, searchQuery]);

  const { monospaceFonts, proportionalFonts } = useMemo(() => {
    const mono: string[] = [];
    const prop: string[] = [];
    for (const font of filteredFonts) {
      if (isMonospaceFont(font)) {
        mono.push(font);
      } else {
        prop.push(font);
      }
    }
    return { monospaceFonts: mono, proportionalFonts: prop };
  }, [filteredFonts]);

  const handleSelect = (font: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(font);
  };

  const clearSearch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSearchQuery("");
    inputRef.current?.focus();
  };

  const lowerSelectedFont = selectedFont.toLowerCase();

  return (
    <div
      className="flex flex-col w-[260px] rounded shadow-lg border text-[12px]"
      style={{
        background: "var(--moba-panel-bg)",
        borderColor: "var(--moba-divider)",
        color: "var(--moba-text)",
      }}
      onClick={(e) => e.stopPropagation()} // Prevent clicking panel from closing or triggering parent clicks
    >
      {/* Search Header */}
      <div className="p-2 border-b" style={{ borderColor: "var(--moba-divider)" }}>
        <div className="relative flex items-center">
          <Search className="absolute left-2 w-3.5 h-3.5 text-[var(--moba-text-muted)] pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t("fontPicker.searchPlaceholder")}
            className="moba-input w-full text-[12px] h-7 pl-7 pr-7 font-normal"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              background: "rgba(0, 0, 0, 0.15)",
              border: "1px solid var(--moba-divider)",
              color: "var(--moba-text)",
              paddingLeft: "28px",
              paddingRight: "28px",
            }}
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              className="absolute right-2 p-0.5 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-[var(--moba-text-muted)] hover:text-[var(--moba-text)]"
              type="button"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Font List */}
      <div
        className="flex-1 overflow-y-auto max-h-[300px] py-1"
        style={{ scrollbarWidth: "thin" }}
      >
        {monospaceFonts.length === 0 && proportionalFonts.length === 0 ? (
          <div className="px-3 py-4 text-center text-[var(--moba-text-muted)] italic">
            {t("fontPicker.noResults")}
          </div>
        ) : (
          <>
            {/* Monospace Section */}
            {monospaceFonts.length > 0 && (
              <div>
                <div
                  className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--moba-text-muted)]"
                  style={{ background: "rgba(0, 0, 0, 0.05)" }}
                >
                  {t("fontPicker.monospaceHeading")}
                </div>
                {monospaceFonts.map((font) => {
                  const isChecked = font.toLowerCase() === lowerSelectedFont;
                  return (
                    <button
                      key={font}
                      type="button"
                      onClick={(e) => handleSelect(font, e)}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--moba-hover)] text-[12px] group"
                    >
                      <span className="w-4 flex-shrink-0 text-center flex items-center justify-center">
                        {isChecked && <Check className="w-3.5 h-3.5 text-[var(--moba-accent)]" />}
                      </span>
                      <span
                        className="flex-1 truncate"
                        style={{ fontFamily: `"${font}", monospace` }}
                        title={font}
                      >
                        {font}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Proportional Section */}
            {proportionalFonts.length > 0 && (
              <div className="mt-1">
                <div
                  className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--moba-text-muted)]"
                  style={{ background: "rgba(0, 0, 0, 0.05)" }}
                >
                  {t("fontPicker.proportionalHeading")}
                </div>
                {proportionalFonts.map((font) => {
                  const isChecked = font.toLowerCase() === lowerSelectedFont;
                  return (
                    <button
                      key={font}
                      type="button"
                      onClick={(e) => handleSelect(font, e)}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--moba-hover)] text-[12px] group"
                    >
                      <span className="w-4 flex-shrink-0 text-center flex items-center justify-center">
                        {isChecked && <Check className="w-3.5 h-3.5 text-[var(--moba-accent)]" />}
                      </span>
                      <span
                        className="flex-1 truncate"
                        style={{ fontFamily: `"${font}", sans-serif` }}
                        title={font}
                      >
                        {font}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useViewerLabels } from "../../viewer/viewerLabels";

interface CharRow {
  code: number;
  hex: string;
  char: string;
  desc: string;
}

const ASCII_NAMES: Record<number, string> = {
  9: "TAB",
  10: "LF",
  13: "CR",
  32: "SPACE",
  160: "NBSP",
};

const EXTRA_SYMBOLS: Array<[number, string]> = [
  [0x00a9, "Copyright"],
  [0x00ae, "Registered"],
  [0x2122, "Trademark"],
  [0x2014, "Em Dash"],
  [0x2026, "Ellipsis"],
  [0x2192, "Right Arrow"],
  [0x2190, "Left Arrow"],
  [0x2022, "Bullet"],
  [0x2713, "Checkmark"],
  [0x2717, "Cross"],
];

export function CharPanel({ onInsertChar }: { onInsertChar: (ch: string) => void }) {
  const label = useViewerLabels();
  const [query, setQuery] = useState("");

  const rows = useMemo<CharRow[]>(() => {
    const out: CharRow[] = [];
    for (let code = 32; code <= 255; code += 1) {
      if (code >= 127 && code <= 159) continue;
      const ch = String.fromCharCode(code);
      out.push({
        code,
        hex: `0x${code.toString(16).toUpperCase().padStart(2, "0")}`,
        char: ch,
        desc: ASCII_NAMES[code] ?? (code < 127 ? "ASCII" : "Latin-1"),
      });
    }
    for (const [code, desc] of EXTRA_SYMBOLS) {
      // Symbols inside the 32-255 range are already listed by code, pushing
      // them again duplicates React keys and rows.
      if (code >= 32 && code <= 255) continue;
      out.push({
        code,
        hex: `U+${code.toString(16).toUpperCase()}`,
        char: String.fromCodePoint(code),
        desc,
      });
    }
    const q = query.trim().toLowerCase();
    if (!q) return out;
    return out.filter(
      (r) =>
        r.char.toLowerCase().includes(q) ||
        r.hex.toLowerCase().includes(q) ||
        String(r.code).includes(q) ||
        r.desc.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="flex flex-col flex-1 min-h-0 text-[11px]" data-testid="notepad-char-panel">
      <div className="p-1.5 border-b border-[var(--taomni-divider)]">
        <input
          type="text"
          className="np-input w-full h-6 text-[11px]"
          placeholder={label("筛选 ASCII / Unicode...", "Filter char / hex...")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-auto font-mono">
        <div className="grid grid-cols-4 px-2 py-1 text-[10px] font-sans text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)]">
          <span>Dec</span><span>Hex</span><span>Char</span><span>Note</span>
        </div>
        {rows.map((r) => (
          <button
            key={r.code}
            type="button"
            data-testid={`notepad-char-row-${r.code}`}
            className="grid grid-cols-4 w-full text-left px-2 py-0.5 hover:bg-[var(--taomni-hover)] border-b border-[var(--taomni-divider)]/30"
            onDoubleClick={() => onInsertChar(r.char)}
            onClick={() => onInsertChar(r.char)}
            title={label("点击插入", "Click to insert")}
          >
            <span>{r.code}</span>
            <span>{r.hex}</span>
            <span className="font-bold text-[var(--taomni-accent)]">{r.char === " " ? "␣" : r.char}</span>
            <span className="truncate font-sans">{r.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

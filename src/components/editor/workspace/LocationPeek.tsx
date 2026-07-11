import { useEffect, useState } from "react";
import type { LspLocation } from "../../../lib/editor/lsp";

export interface LocationPeekState {
  title: string;
  locations: LspLocation[];
}

interface LocationPeekProps {
  open: boolean;
  state: LocationPeekState | null;
  onClose: () => void;
  onOpen: (location: LspLocation) => void;
}

export function LocationPeek({ open, state, onClose, onOpen }: LocationPeekProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open, state?.title, state?.locations.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((current) => Math.min(current + 1, Math.max(0, (state?.locations.length ?? 1) - 1)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const location = state?.locations[index];
        if (location) onOpen(location);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, onClose, onOpen, open, state]);

  if (!open || !state) return null;

  const groups = new Map<string, LspLocation[]>();
  for (const location of state.locations) {
    const key = location.path ?? location.uri;
    const list = groups.get(key) ?? [];
    list.push(location);
    groups.set(key, list);
  }

  let flatIndex = 0;

  return (
    <div
      data-testid="code-workspace-location-peek"
      className="absolute bottom-24 left-1/2 z-40 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-xl"
    >
      <div className="flex h-8 items-center border-b border-[var(--taomni-code-border)] px-3 text-[11px] font-semibold text-[var(--taomni-code-text)]">
        <span className="min-w-0 flex-1 truncate">{state.title}</span>
        <span className="text-[10px] font-normal text-[var(--taomni-code-muted)]">
          {state.locations.length} result{state.locations.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="max-h-64 overflow-auto py-1 text-[11px]">
        {[...groups.entries()].map(([path, locations]) => (
          <div key={path}>
            <div className="px-3 py-1 text-[10px] font-medium text-[var(--taomni-code-muted)]">{path}</div>
            {locations.map((location) => {
              const current = flatIndex;
              flatIndex += 1;
              return (
                <button
                  key={`${location.uri}:${location.range.start.line}:${location.range.start.character}:${current}`}
                  type="button"
                  data-selected={current === index || undefined}
                  className="flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
                  onMouseEnter={() => setIndex(current)}
                  onClick={() => onOpen(location)}
                >
                  <span className="text-[var(--taomni-code-text)]">
                    Line {location.range.start.line + 1}:{location.range.start.character + 1}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">
        ↑↓ select · Enter open · Esc close
      </div>
    </div>
  );
}

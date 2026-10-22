import { ChevronDown, ChevronRight } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";

export interface SettingsSearchContextValue {
  searching: boolean;
  matchedSet: Set<string>;
  activeId: string | null;
  register: (id: string, el: HTMLElement | null) => void;
}

export const SettingsSearchContext = createContext<SettingsSearchContextValue | null>(null);

export const SettingsGroupExpandedContext = createContext(true);

// Wraps one searchable settings unit: registers its DOM node so the panel can
// scroll to it, and reflects match state through styling plus a
// `data-search-match` attribute that tests can assert on without a real scroll.
export function SettingsAnchor({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useContext(SettingsSearchContext);
  const groupExpanded = useContext(SettingsGroupExpandedContext);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ctx?.register(id, ref.current);
    return () => ctx?.register(id, null);
  }, [ctx, id]);

  const searching = ctx?.searching ?? false;
  const matched = ctx?.matchedSet.has(id) ?? false;
  const active = (ctx?.activeId ?? null) === id;

  return (
    <div
      ref={ref}
      data-search-id={id}
      data-search-match={searching ? String(matched) : undefined}
      className={className}
      style={{
        scrollMarginTop: 72,
        borderRadius: matched ? 10 : undefined,
        outline: matched ? `${active ? 2 : 1}px solid var(--taomni-accent)` : undefined,
        outlineOffset: matched ? 3 : undefined,
        boxShadow: active ? "0 0 0 3px var(--taomni-selected)" : undefined,
        opacity: searching && !matched ? 0.4 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      {groupExpanded ? children : null}
    </div>
  );
}

export function SettingsGroup({
  id,
  title,
  expanded,
  onToggle,
  matchCount,
  searching,
  children,
}: {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  matchCount: number;
  searching: boolean;
  children: React.ReactNode;
}) {
  const hasMatch = matchCount > 0;
  return (
    <SettingsGroupExpandedContext.Provider value={expanded}>
      <section
        data-testid={`settings-group-${id}`}
        data-group-id={id}
        data-expanded={expanded ? "true" : "false"}
        data-group-match={searching ? String(hasMatch) : undefined}
        className="mb-4"
        style={{
          opacity: searching && !hasMatch ? 0.55 : 1,
          transition: "opacity 120ms ease",
        }}
      >
        <button
          type="button"
          data-testid={`settings-group-toggle-${id}`}
          aria-expanded={expanded}
          aria-controls={`settings-group-body-${id}`}
          className="flex w-full items-center gap-2 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] px-3 py-2 text-left hover:bg-[var(--taomni-control-hover)]"
          style={
            searching && hasMatch
              ? { outline: "1px solid var(--taomni-accent)", outlineOffset: 1 }
              : undefined
          }
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--taomni-text-muted)]" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--taomni-text-muted)]" />
          )}
          <span className="flex-1 text-[13px] font-semibold tracking-wide">{title}</span>
          {searching && hasMatch && (
            <span
              data-testid={`settings-group-match-count-${id}`}
              className="tabular-nums text-[11px] font-medium text-[var(--taomni-accent)]"
            >
              {matchCount}
            </span>
          )}
        </button>
        {/* Keep anchor shells mounted for search/deep-link registration, but defer their heavy controls. */}
        <div
          id={`settings-group-body-${id}`}
          data-testid={`settings-group-body-${id}`}
          hidden={!expanded}
          className="mt-2"
        >
          {children}
        </div>
      </section>
    </SettingsGroupExpandedContext.Provider>
  );
}

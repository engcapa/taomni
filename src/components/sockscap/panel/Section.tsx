import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";


export function Section({
  sectionId,
  title,
  children,
  defaultExpanded = false,
}: {
  sectionId: string;
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = `sockscap-section-${sectionId}-content`;
  return (
    <section className="sockscap-section rounded-lg border border-[var(--taomni-divider)] overflow-hidden">
      <button
        type="button"
        data-testid={`sockscap-section-${sectionId}-toggle`}
        className="sockscap-section-toggle w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--taomni-hover)] transition-colors"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        <h3 className="sockscap-section-title text-[12px] font-semibold truncate">
          {title}
        </h3>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        )}
      </button>
      <div
        id={contentId}
        hidden={!expanded}
        className="sockscap-section-content border-t border-[var(--taomni-divider)] p-3"
      >
        {children}
      </div>
    </section>
  );
}

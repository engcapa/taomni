import { memo, type MouseEvent, type RefObject } from "react";
import type { LspDocumentSymbol } from "../../../../lib/editor/lsp";
import { ChevronRight, File, Folder, Hash, MoreHorizontal } from "../icons";
import type { BreadcrumbItem, BreadcrumbPathSegment } from "./model";

interface BreadcrumbTrailProps {
  fullItems: BreadcrumbItem[];
  visibleItems: BreadcrumbItem[];
  collapsed: boolean;
  activeNavigationBar: boolean;
  focusedIndex: number | null;
  measureRef: RefObject<HTMLDivElement | null>;
  onOpenPath: (path: BreadcrumbPathSegment, anchor: HTMLElement) => void;
  onOpenSymbol: (symbol: LspDocumentSymbol, anchor: HTMLElement) => void;
  onOpenCollapsed: (paths: BreadcrumbPathSegment[], anchor: HTMLElement) => void;
  onPathContextMenu: (event: MouseEvent, path: BreadcrumbPathSegment) => void;
}

/** Keep both measured and visible trails out of unrelated workspace updates. */
export const BreadcrumbTrail = memo(function BreadcrumbTrail({
  fullItems, visibleItems, collapsed, activeNavigationBar, focusedIndex,
  measureRef, onOpenPath, onOpenSymbol, onOpenCollapsed, onPathContextMenu,
}: BreadcrumbTrailProps) {
  const renderItems = (items: BreadcrumbItem[], compact: boolean, interactive: boolean) => items.map((item, index) => {
    const path = item.type === "path" ? item.value : null;
    const symbol = item.type === "symbol" ? item.value : null;
    const label = path?.label ?? symbol?.name ?? "";
    // IDEA's navigation bar keeps the file name whole and truncates the
    // surrounding directories/members first; a narrow status bar otherwise
    // squeezed the file segment to zero width (ED-PARITY-011 DEC-011-02).
    const flexible = compact && path?.kind !== "file";
    const isFocused = focusedIndex === index;
    const icon = path?.kind === "root" || path?.kind === "directory" ? (
      <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
    ) : path?.kind === "file" ? (
      <File className="h-3 w-3 shrink-0" />
    ) : item.type === "collapsed" ? (
      <MoreHorizontal className="h-3 w-3" />
    ) : (
      <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
    );

    if (item.type === "collapsed") {
      return (
        <span key={`collapsed:${index}`} className="inline-flex shrink-0 items-center">
          {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
          {interactive ? (
            <button
              type="button"
              className={`inline-flex h-5 items-center rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""
                }`}
              aria-label="Hidden breadcrumb segments"
              id={`code-workspace-breadcrumb-segment-${index}`}
              tabIndex={activeNavigationBar ? -1 : 0}
              data-testid="code-workspace-breadcrumb-collapsed"
              data-nav-index={index}
              onClick={(event) => {
                if (item.hiddenPaths.length > 0) {
                  onOpenCollapsed(item.hiddenPaths, event.currentTarget);
                }
              }}
            >
              {icon}
            </button>
          ) : (
            <span className="inline-flex h-5 items-center rounded px-1">{icon}</span>
          )}
        </span>
      );
    }

    const content = (
      <>
        {icon}
        <span className={flexible ? "truncate" : undefined}>{label}</span>
      </>
    );

    return (
      <span
        key={`${item.type}:${label}:${index}`}
        className={`inline-flex min-w-0 items-center ${flexible ? "flex-1" : "shrink-0"}`}
      >
        {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0" />}
        {interactive ? (
          <button
            type="button"
            className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${flexible ? "flex-1" : ""
              } ${isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""}`}
            aria-haspopup="listbox"
            aria-current={index === items.length - 1 ? (path?.kind === "file" ? "page" : symbol ? "location" : undefined) : undefined}
            id={`code-workspace-breadcrumb-segment-${index}`}
            tabIndex={activeNavigationBar ? -1 : 0}
            data-nav-index={index}
            data-focused={isFocused ? "true" : undefined}
            data-testid={path
              ? `code-workspace-breadcrumb-path-${path.kind}`
              : "code-workspace-breadcrumb-symbol"}
            onClick={(event) => {
              if (path) onOpenPath(path, event.currentTarget);
              if (symbol) onOpenSymbol(symbol, event.currentTarget);
            }}
            onContextMenu={(event) => {
              if (path) onPathContextMenu(event, path);
            }}
          >
            {content}
          </button>
        ) : (
          <span className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 ${flexible ? "flex-1" : ""}`}>
            {content}
          </span>
        )}
      </span>
    );
  });

  return (
    <>
      <div ref={measureRef} aria-hidden="true"
        className="pointer-events-none absolute invisible w-max whitespace-nowrap">
        {renderItems(fullItems, false, false)}
      </div>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {renderItems(visibleItems, collapsed, true)}
      </div>
    </>
  );
});

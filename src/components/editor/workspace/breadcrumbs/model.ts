import type { LspDocumentSymbol, LspPosition } from "../../../../lib/editor/lsp";

export interface BreadcrumbPathSegment {
  label: string;
  path: string;
  kind: "root" | "directory" | "file";
}

/** Child/sibling entry shown in a path-segment dropdown (IDEA-style). */
export interface BreadcrumbPathChild {
  label: string;
  path: string;
  kind: "directory" | "file";
  /** True when this entry is the next segment on the current trail. */
  active?: boolean;
}

export interface BreadcrumbPathAction {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export type BreadcrumbItem =
  | { type: "path"; value: BreadcrumbPathSegment; }
  | { type: "symbol"; value: LspDocumentSymbol; }
  | { type: "collapsed"; hiddenPaths: BreadcrumbPathSegment[]; };

export interface BreadcrumbsProps {
  /** `statusbar` renders compactly inside the status bar navigation slot. */
  variant?: "bar" | "statusbar";
  pathSegments: BreadcrumbPathSegment[];
  symbols: LspDocumentSymbol[];
  position: LspPosition;
  /**
   * Load children of a directory/root, or siblings of a file (parent listing).
   * When provided, path segment clicks open an IDEA-style navigation popup.
   */
  loadPathChildren?: (segment: BreadcrumbPathSegment) => Promise<BreadcrumbPathChild[]>;
  /** Navigate to a child/sibling picked from the path dropdown. */
  onPathNavigate?: (child: BreadcrumbPathChild, fromSegment: BreadcrumbPathSegment) => void;
  /** Context / footer actions for a path segment (copy path, reveal, …). */
  pathActionsForSegment?: (segment: BreadcrumbPathSegment) => BreadcrumbPathAction[];
  /**
   * Fallback simple click when `loadPathChildren` is not provided
   * (e.g. reveal the segment in the project tree).
   */
  onPathClick?: (segment: BreadcrumbPathSegment) => void;
  onSymbolClick?: (symbol: LspDocumentSymbol) => void;
  /** When activated via Alt+Home / workspace.activateNavigationBar, keyboard arrow navigation is enabled. */
  activeNavigationBar?: boolean;
  onCloseNavigationBar?: () => void;
}

export type OpenPopup =
  | {
    kind: "path";
    segment: BreadcrumbPathSegment;
    anchor: DOMRect;
    children: BreadcrumbPathChild[];
    loading: boolean;
    error: string | null;
  }
  | {
    kind: "symbol";
    symbol: LspDocumentSymbol;
    siblings: LspDocumentSymbol[];
    anchor: DOMRect;
  }
  | {
    kind: "collapsed";
    segments: BreadcrumbPathSegment[];
    anchor: DOMRect;
  };

export interface SegmentPopupProps {
  open: OpenPopup;
  query: string;
  selectedIndex: number;
  actions: BreadcrumbPathAction[];
  onQueryChange: (value: string) => void;
  onSelectedIndexChange: (index: number) => void;
  onClose: (restoreFocus?: boolean) => void;
  onPickPathChild: (child: BreadcrumbPathChild) => void;
  onPickSymbol: (symbol: LspDocumentSymbol) => void;
  onPickCollapsedSegment: (segment: BreadcrumbPathSegment) => void;
  onAction: (action: BreadcrumbPathAction) => void;
}

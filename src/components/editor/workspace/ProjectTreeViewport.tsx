import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { TreeSelection } from "./codeWorkspaceModel";
import { registerProjectTreeNavigation } from "./projectTreeNavigation";
import { projectTreeNavigationTarget } from "./projectTreeNavigationModel";
import { treeSelectionKey, type ProjectTreeRow } from "./projectTreeRows";
import type { ProjectTreeProps } from "./projectTreeTypes";

const VIRTUAL_THRESHOLD = 80;

export function ProjectTreeViewport({ rows, selected, viewMode }: {
  rows: readonly ProjectTreeRow[]; selected: TreeSelection | null; viewMode: ProjectTreeProps["treeViewMode"];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [insets, setInsets] = useState({ margin: 0, header: 0, bottom: 0 });
  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const tree = () => hostRef.current?.closest<HTMLElement>('[data-testid="code-workspace-tree"], [role="tree"]') ?? null;
  useLayoutEffect(() => {
    const host = hostRef.current;
    const element = tree();
    if (!virtual || !host || !element) return;
    const header = element.querySelector<HTMLElement>('[data-testid="code-workspace-list-columns"]');
    const measure = () => {
      const margin = host.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
      const style = getComputedStyle(element);
      const height = (header?.getBoundingClientRect().height ?? 0) + (parseFloat(style.paddingTop) || 0);
      const bottom = parseFloat(style.paddingBottom) || 0;
      setInsets((previous) => previous.margin === margin && previous.header === height && previous.bottom === bottom
        ? previous : { margin, header: height, bottom });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (header) observer?.observe(header);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [virtual, viewMode]);
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement: tree,
    getItemKey: (index) => rows[index].key,
    estimateSize: () => 28,
    overscan: 8,
    scrollMargin: insets.margin,
    scrollPaddingStart: insets.header,
    scrollPaddingEnd: insets.bottom,
    // The scroll container owns this padding. Include it in the virtual
    // scroll range without adding the same space to the inner spacer twice.
    paddingEnd: insets.bottom,
    enabled: virtual,
    initialRect: { width: 320, height: 600 },
  });
  const items = list.getVirtualItems();
  const selectedKey = treeSelectionKey(selected);
  const previousSelection = useRef({ key: null as string | null, virtual: false });
  const reveal = useCallback((index: number) => {
    const item = items.find((value) => value.index === index);
    const offset = list.scrollOffset ?? 0;
    if (item && item.start >= offset + insets.header && item.end <= offset + (list.scrollRect?.height ?? 0) - insets.bottom) return;
    list.scrollToIndex(index, { align: "auto" });
  }, [items, list, insets.header, insets.bottom]);

  useLayoutEffect(() => {
    const element = tree();
    if (!virtual || !element) return;
    return registerProjectTreeNavigation(element, (key, actions) => {
      const target = projectTreeNavigationTarget(rows, selected, key);
      if (!target) return true;
      if (target.kind === "toggle") {
        if (target.selection.kind === "root") actions.onToggleRoot(target.selection.rootId);
        else actions.onToggleDir(target.selection.rootId, target.selection.path);
        return true;
      }
      actions.onSelect(target.row.selection!);
      setFocusKey(target.row.key);
      reveal(rows.indexOf(target.row));
      return true;
    });
  }, [virtual, rows, selected, reveal]);

  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { key: selectedKey, virtual };
    if (previous.key === selectedKey && previous.virtual === virtual) return;
    if (!virtual || !selectedKey) return;
    const index = rows.findIndex((row) => treeSelectionKey(row.selection) === selectedKey);
    if (index >= 0) reveal(index);
  }, [selectedKey, virtual, rows, reveal]);

  useLayoutEffect(() => {
    if (!focusKey) return;
    const index = rows.findIndex((row) => row.key === focusKey);
    if (index < 0) { setFocusKey(null); return; }
    const row = hostRef.current?.querySelector<HTMLElement>(`[data-virtual-index="${index}"] [role="treeitem"]`);
    if (!row) return;
    const active = document.activeElement;
    const element = tree();
    const pane = element?.closest('[data-testid="code-workspace-tree-pane"]');
    if (active === document.body || !active?.isConnected || active === pane || element?.contains(active)) row.focus({ preventScroll: true });
    setFocusKey(null);
  }, [focusKey, rows, items]);

  if (!virtual) return <>{rows.map((row) => <Fragment key={row.key}>{row.render()}</Fragment>)}</>;
  return (
    <div ref={hostRef} data-testid="code-workspace-tree-viewport" data-row-count={rows.length}
      style={{ position: "relative", width: "100%", height: Math.max(0, list.getTotalSize() - insets.bottom) }}>
      {items.map((item) => (
        <div key={item.key} data-index={item.index} data-virtual-index={item.index} ref={list.measureElement}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - insets.margin}px)` }}>
          {rows[item.index].render()}
        </div>
      ))}
    </div>
  );
}

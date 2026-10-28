import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContextMenu } from "../../../ContextMenu";
import { useElementResizeFrame } from "../../../../hooks/useElementResizeFrame";
import { computeEditorTabScrollState, editorTabScrollStep, ensureChildVisibleScrollLeft, setScrollLeft, type EditorTabScrollState } from "../editorTabScroll";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3, orderTabsForDisplay, type TabEvictionMeta } from "../workspaceTabPolicy";

export interface UseEditorGroupTabsContext {
  openOrder: string[];
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  pinnedKeys: string[];
  previewKey: string | null;
  lastUsedByKey: ReadonlyMap<string, number> | undefined;
  tabPolicy: import("../workspaceTabPolicy").WorkspaceTabPolicyV3 | undefined;
  activeKey: string | null;
  onClose: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseAll: () => void;
  onCloseUnmodified: () => void;
  onCloseRight: (key: string) => void;
  onCopyPath: (key: string, absolute: boolean) => void;
  onSplitRight: (key: string) => void;
  onSplitDown: (key: string) => void;
  onMoveTabToNextSplit: ((key: string) => void) | undefined;
  onMoveTabToPreviousSplit: ((key: string) => void) | undefined;
  onPin: (key: string, pinned: boolean) => void;
  onRevealInTree: (key: string) => void;
  onRevealInSystem: (key: string) => void;
  onOpenInTerminal: (key: string) => void;
  onLocalHistory: ((key: string) => void) | undefined;
}

export function useEditorGroupTabs(context: UseEditorGroupTabsContext) {
  const {
    openOrder,
    openFiles,
    pinnedKeys,
    previewKey,
    lastUsedByKey,
    tabPolicy,
    activeKey,
    onClose,
    onCloseOthers,
    onCloseAll,
    onCloseUnmodified,
    onCloseRight,
    onCopyPath,
    onSplitRight,
    onSplitDown,
    onMoveTabToNextSplit,
    onMoveTabToPreviousSplit,
    onPin,
    onRevealInTree,
    onRevealInSystem,
    onOpenInTerminal,
    onLocalHistory,
  } = context; // eslint-disable-line react-hooks/exhaustive-deps

  const tabMenu = useContextMenu();

  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [tabScrollState, setTabScrollState] = useState<EditorTabScrollState>({
    overflow: false,
    atStart: true,
    atEnd: true,
  });
  const tabEvictionMeta = useMemo(() => {
    const map = new Map<string, TabEvictionMeta>();
    for (const key of openOrder) {
      map.set(key, {
        key,
        dirty: !!openFiles[key]?.dirty,
        pinned: pinnedKeys.includes(key),
        preview: previewKey === key,
        lastUsedAt: lastUsedByKey?.get(key) ?? 0,
      });
    }
    return map;
  }, [openOrder, openFiles, pinnedKeys, previewKey, lastUsedByKey]);

  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);

  const orderedKeys = useMemo(() => {
    return [
      ...orderTabsForDisplay(
        openOrder,
        tabEvictionMeta,
        tabPolicy ?? DEFAULT_WORKSPACE_TAB_POLICY_V3,
      ),
    ];
  }, [openOrder, tabEvictionMeta, tabPolicy]);

  const isSeparatePinnedRow = tabPolicy?.pinnedRow === "separate";
  const separatePinnedKeys = useMemo(() => {
    return isSeparatePinnedRow ? orderedKeys.filter((k) => pinnedSet.has(k)) : [];
  }, [isSeparatePinnedRow, orderedKeys, pinnedSet]);

  const normalDisplayKeys = useMemo(() => {
    return isSeparatePinnedRow ? orderedKeys.filter((k) => !pinnedSet.has(k)) : orderedKeys;
  }, [isSeparatePinnedRow, orderedKeys, pinnedSet]);

  const updateTabScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el || el.clientWidth <= 0) return;
    const next = computeEditorTabScrollState(el);
    setTabScrollState((prev) =>
      prev.overflow === next.overflow &&
        prev.atStart === next.atStart &&
        prev.atEnd === next.atEnd
        ? prev
        : next,
    );
  }, []);

  const scrollTabsBy = useCallback(
    (direction: "left" | "right") => {
      const el = tabScrollRef.current;
      if (!el) return;
      const delta = editorTabScrollStep(el.clientWidth);
      setScrollLeft(el, el.scrollLeft + (direction === "right" ? delta : -delta));
      updateTabScrollState();
    },
    [updateTabScrollState],
  );

  const measureTabs = useCallback(() => {
    const container = tabScrollRef.current;
    if (!container || container.clientWidth <= 0) return;
    const child = Array.from(container.children).find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.editorTabKey === activeKey,
    );
    if (child) {
      const nextLeft = ensureChildVisibleScrollLeft(container, child);
      if (nextLeft !== container.scrollLeft) setScrollLeft(container, nextLeft);
    }
    updateTabScrollState();
  }, [activeKey, updateTabScrollState]);
  const scheduleMeasurement = useElementResizeFrame(tabScrollRef, measureTabs);
  useEffect(() => {
    scheduleMeasurement();
  }, [activeKey, openOrder, orderedKeys.length, scheduleMeasurement]);

  const getTabMenuItems = (key: string): import("../../../ContextMenu").MenuItem[] => {
    const pinned = pinnedSet.has(key);
    const index = openOrder.indexOf(key);
    const hasOthers = openOrder.length > 1;
    const hasRight = index >= 0 && index < openOrder.length - 1;
    // ED-PARITY-021 DEC-021-02: IDEA tab menu order — close group, copy path,
    // splits, pin, Open In ›, Local History; availability follows the tab set.
    return [
      { label: "Close", shortcut: "Ctrl+F4", onClick: () => onClose(key) },
      { label: "Close Other Tabs", disabled: !hasOthers, onClick: () => onCloseOthers(key) },
      { label: "Close All Tabs", onClick: onCloseAll },
      { label: "Close Unmodified Tabs", onClick: onCloseUnmodified },
      { label: "Close Tabs to the Right", disabled: !hasRight, onClick: () => onCloseRight(key) },
      { separator: true, label: "" },
      { label: "Copy Path", onClick: () => onCopyPath(key, true) },
      { label: "Copy Relative Path", onClick: () => onCopyPath(key, false) },
      { separator: true, label: "" },
      { label: "Split Right", onClick: () => onSplitRight(key) },
      { label: "Split Down", onClick: () => onSplitDown(key) },
      ...(onMoveTabToNextSplit ? [
        { label: "Move Tab to Next Split", onClick: () => onMoveTabToNextSplit(key) },
      ] : []),
      ...(onMoveTabToPreviousSplit ? [
        { label: "Move Tab to Previous Split", onClick: () => onMoveTabToPreviousSplit(key) },
      ] : []),
      { separator: true, label: "" },
      { label: pinned ? "Unpin Tab" : "Pin Tab", onClick: () => onPin(key, !pinned) },
      { separator: true, label: "" },
      {
        label: "Open In",
        children: [
          { label: "Project View", shortcut: "Alt+F1", onClick: () => onRevealInTree(key) },
          { label: "Explorer", onClick: () => onRevealInSystem(key) },
          { label: "Terminal", onClick: () => onOpenInTerminal(key) },
        ],
      },
      ...(onLocalHistory ? [
        { label: "Local History…", onClick: () => onLocalHistory(key) },
      ] : []),
    ];
  };
  const showTabMenu = (event: React.MouseEvent, key: string) => tabMenu.show(event, getTabMenuItems(key));
  return {
    isSeparatePinnedRow,
    separatePinnedKeys,
    showTabMenu,
    getTabMenuItems,
    tabScrollState,
    scrollTabsBy,
    tabScrollRef,
    updateTabScrollState,
    normalDisplayKeys,
    pinnedSet,
    tabMenu,
    orderedKeys,
  };
}

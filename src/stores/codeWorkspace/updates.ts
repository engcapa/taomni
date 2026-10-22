import { type LayoutNode } from "../../components/editor/workspace/recursiveLayoutTree";
import { type CodeWorkspaceEditorGroupState, type CodeWorkspaceFileKeyChanges, type CodeWorkspaceInstanceUi, type EditorGroupId, type Updater } from "./model";

export function resolveUpdater<T>(prev: T, updater: Updater<T>): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
}

export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameLayoutTree(left: LayoutNode, right: LayoutNode): boolean {
  if (left === right) return true;
  if (left.type !== right.type || left.id !== right.id) return false;
  if (left.type === "leaf" && right.type === "leaf") {
    return left.activeKey === right.activeKey && sameStringArray(left.openFileKeys, right.openFileKeys);
  }
  if (left.type === "split" && right.type === "split") {
    return left.orientation === right.orientation
      && left.ratios.length === right.ratios.length
      && left.ratios.every((ratio, index) => ratio === right.ratios[index])
      && left.children.length === right.children.length
      && left.children.every((child, index) => sameLayoutTree(child, right.children[index]));
  }
  return false;
}

export function sameEditorGroups(
  left: Readonly<Record<EditorGroupId, CodeWorkspaceEditorGroupState>>,
  right: Readonly<Record<EditorGroupId, CodeWorkspaceEditorGroupState>>,
): boolean {
  if (left === right) return true;
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every((id) => {
    const leftGroup = left[id];
    const rightGroup = right[id];
    return rightGroup !== undefined
      && leftGroup.id === rightGroup.id
      && leftGroup.activeKey === rightGroup.activeKey
      && leftGroup.previewKey === rightGroup.previewKey
      && sameStringArray(leftGroup.openOrder, rightGroup.openOrder)
      && sameStringArray(leftGroup.pinnedKeys, rightGroup.pinnedKeys);
  });
}

export function remappedFileKey(
  key: string,
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): string | null {
  const mapped = Object.prototype.hasOwnProperty.call(keyChanges, key) ? keyChanges[key] : key;
  return mapped != null && validKeys.has(mapped) ? mapped : null;
}

export function remapFileKeyList(
  keys: readonly string[],
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const key of keys) {
    const mapped = remappedFileKey(key, keyChanges, validKeys);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

export function reconcileEditorGroupFiles(
  group: CodeWorkspaceEditorGroupState,
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): CodeWorkspaceEditorGroupState {
  const activeIndex = group.activeKey ? group.openOrder.indexOf(group.activeKey) : -1;
  const openOrder = remapFileKeyList(group.openOrder, keyChanges, validKeys);
  const mappedActive = group.activeKey
    ? remappedFileKey(group.activeKey, keyChanges, validKeys)
    : null;
  const activeKey = mappedActive && openOrder.includes(mappedActive)
    ? mappedActive
    : openOrder[Math.min(Math.max(activeIndex, 0), Math.max(openOrder.length - 1, 0))] ?? null;
  const mappedPreview = group.previewKey
    ? remappedFileKey(group.previewKey, keyChanges, validKeys)
    : null;
  return {
    ...group,
    openOrder,
    activeKey,
    previewKey: mappedPreview && openOrder.includes(mappedPreview) ? mappedPreview : null,
    pinnedKeys: remapFileKeyList(group.pinnedKeys, keyChanges, validKeys)
      .filter((key) => openOrder.includes(key)),
  };
}

export function remapMarkdownModes(
  current: CodeWorkspaceInstanceUi["markdownModes"],
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): CodeWorkspaceInstanceUi["markdownModes"] {
  const next: CodeWorkspaceInstanceUi["markdownModes"] = {};
  for (const [key, mode] of Object.entries(current)) {
    const mapped = remappedFileKey(key, keyChanges, validKeys);
    if (mapped) next[mapped] = mode;
  }
  return next;
}

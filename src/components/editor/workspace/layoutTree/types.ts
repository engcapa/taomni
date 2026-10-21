/**
 * Recursive Split Layout Tree Model (A2 / N6.1).
 *
 * Implements arbitrary nested horizontal and vertical editor splits, ratio rebalancing,
 * leaf group tab movement, atomic layout mutation commits, and schema v2 serialization/deserialization.
 */

export interface LeafGroupNode {
  type: "leaf";
  id: string;
  openFileKeys: string[];
  activeKey: string | null;
}

export interface SplitLayoutNode {
  type: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  children: LayoutNode[];
  ratios: number[]; // e.g. [0.5, 0.5]
}

export type LayoutNode = SplitLayoutNode | LeafGroupNode;

export interface LayoutEditorGroupState {
  id: string;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

export type LayoutMutationResult =
  | {
    kind: "changed";
    tree: LayoutNode;
    groups: Record<string, LayoutEditorGroupState>;
    activeGroupId: string;
    migration?: {
      destinationLeafId: string;
      migratedKeys: string[];
    };
  }
  | { kind: "no-op" | "failed"; reason: string; };

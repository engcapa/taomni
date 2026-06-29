import type { GitLogEntry } from "./git";

export interface GraphEdge {
  // Column at the top edge of the row's cell.
  fromColumn: number;
  // Column at the bottom edge of the row's cell.
  toColumn: number;
  color: number;
}

export interface GraphRow {
  oid: string;
  column: number;
  color: number;
  // Lines to draw within this row's cell (top edge -> bottom edge).
  edges: GraphEdge[];
  // Total lane columns occupied around this row (for cell width).
  width: number;
}

/**
 * Compute commit-graph lanes from a linear `git log` ordering using parent
 * pointers. Produces, per row, the node column and the line segments to render
 * in that row's cell. A lane is a slot tracking which commit it currently
 * expects next; merges open extra lanes, and a commit closes the lanes that
 * were waiting for it.
 */
export function buildGraph(entries: GitLogEntry[]): GraphRow[] {
  const lanes: (string | null)[] = []; // oid each lane currently expects
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const firstFree = () => {
    const idx = lanes.findIndex((l) => l === null);
    return idx === -1 ? lanes.length : idx;
  };

  for (const entry of entries) {
    const before = lanes.slice();
    const beforeColor = laneColor.slice();

    // Lanes waiting for this commit.
    const mine: number[] = [];
    for (let i = 0; i < before.length; i += 1) if (before[i] === entry.oid) mine.push(i);

    let column: number;
    let color: number;
    if (mine.length > 0) {
      column = mine[0];
      color = beforeColor[column] ?? nextColor;
    } else {
      column = firstFree();
      color = nextColor;
      nextColor += 1;
      lanes[column] = entry.oid;
      laneColor[column] = color;
    }

    // Close extra lanes that merged into this node.
    for (let k = 1; k < mine.length; k += 1) {
      lanes[mine[k]] = null;
    }

    // Route parents: first parent keeps this column; extra parents open lanes.
    const parents = entry.parents;
    if (parents.length === 0) {
      lanes[column] = null;
    } else {
      lanes[column] = parents[0];
      laneColor[column] = color;
      for (let p = 1; p < parents.length; p += 1) {
        const free = firstFree();
        lanes[free] = parents[p];
        laneColor[free] = nextColor;
        nextColor += 1;
      }
    }

    // Build edges: top (before layout) -> node, then node -> bottom (after layout).
    const edges: GraphEdge[] = [];
    for (let i = 0; i < before.length; i += 1) {
      const oid = before[i];
      if (oid === null) continue;
      if (oid === entry.oid) {
        edges.push({ fromColumn: i, toColumn: column, color: beforeColor[i] ?? color });
      } else {
        const dest = lanes.indexOf(oid);
        edges.push({ fromColumn: i, toColumn: dest === -1 ? i : dest, color: beforeColor[i] ?? 0 });
      }
    }
    for (let i = 0; i < lanes.length; i += 1) {
      const oid = lanes[i];
      if (oid === null) continue;
      if (!before.includes(oid)) {
        // New lane originating from this node (first or extra parent).
        edges.push({ fromColumn: column, toColumn: i, color: laneColor[i] ?? color });
      }
    }

    // Trim trailing nulls to keep width tight.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColor.pop();
    }

    const width = Math.max(column + 1, before.filter((l) => l !== null).length, lanes.length);
    rows.push({ oid: entry.oid, column, color, edges, width });
  }

  return rows;
}

export const GRAPH_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export function graphColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

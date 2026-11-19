interface DrawioCell {
  element: Element;
  cell: Element;
}

function isStructuralCell(cell: Element): boolean {
  return cell.getAttribute("vertex") !== "1" && cell.getAttribute("edge") !== "1";
}

/** Draw.io gives every cell an ID, including its structural root and layers. */
export function readDrawioGraph(model: Element): {
  rootId: string;
  layerIds: string[];
  cells: Map<string, DrawioCell>;
} {
  const root = Array.from(model.children).find((child) => child.tagName === "root");
  if (model.tagName !== "mxGraphModel" || !root) throw new Error("Invalid draw.io graph model");
  const cells = new Map<string, DrawioCell>();
  for (const element of Array.from(root.children)) {
    const cell = element.tagName === "mxCell" ? element
      : Array.from(element.children).find((child) => child.tagName === "mxCell");
    if (!cell) continue;
    const id = element.getAttribute("id") || cell.getAttribute("id");
    if (!id || cells.has(id)) throw new Error("draw.io contains missing or duplicate cell IDs");
    cells.set(id, { element, cell });
  }
  const entries = Array.from(cells);
  const roots = entries.filter(([, { cell }]) => !cell.getAttribute("parent"));
  if (roots.length !== 1 || !isStructuralCell(roots[0][1].cell)) throw new Error("Invalid draw.io graph root");
  const [rootId] = roots[0];
  const layerIds = entries.filter(([, { cell }]) => cell.getAttribute("parent") === rootId && isStructuralCell(cell)).map(([id]) => id);
  if (!layerIds.length) throw new Error("Invalid draw.io graph layers");

  for (const [id] of entries) {
    const path = new Set<string>();
    let cursor = id;
    while (cursor !== rootId) {
      if (path.has(cursor) || path.size >= 100) throw new Error("draw.io contains cyclic or deeply nested parents");
      path.add(cursor);
      const parent = cells.get(cursor)?.cell.getAttribute("parent");
      if (!parent || !cells.has(parent)) throw new Error("draw.io has a missing parent cell");
      cursor = parent;
    }
  }
  return { rootId, layerIds, cells };
}

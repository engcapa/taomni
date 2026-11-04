import { useEffect, useState, type MouseEvent } from "react";
import { ContextMenu } from "../../ContextMenu";
import { gitFileMenuItems, type GitFileTarget } from "./fileActions";

/** Capture the clicked file; a repository/revision switch invalidates its menu. */
export function useGitFileContextMenu(repoRoot: string | null, revision: string | null) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: GitFileTarget;
    revision: string | null;
  } | null>(null);
  useEffect(() => setMenu(null), [repoRoot, revision]);
  const current = menu?.target.repoRoot === repoRoot && menu.revision === revision ? menu : null;
  return {
    openFileMenu: (path: string, event: MouseEvent) => {
      event.preventDefault();
      if (repoRoot) setMenu({ x: event.clientX, y: event.clientY, target: { repoRoot, path }, revision });
    },
    fileMenu: current ? (
      <ContextMenu
        x={current.x}
        y={current.y}
        onClose={() => setMenu(null)}
        items={gitFileMenuItems([current.target])}
      />
    ) : null,
  };
}

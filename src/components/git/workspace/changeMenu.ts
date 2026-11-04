import { type MenuItem } from "../../ContextMenu";
import { gitFileMenuItems, type GitFileTarget } from "../shared/fileActions";


export function workspaceChangeMenuItems({
  entries,
  contextTarget,
  onStage,
  onUnstage,
  onDiscard,
}: {
  entries: Array<{
    repoRoot: string;
    repoName: string;
    change: { path: string; };
  }>;
  contextTarget?: GitFileTarget;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}): MenuItem[] {
  const disabled=entries.length===0;
  return [
    { label: "Stage",disabled,onClick: onStage },
    { label: "Unstage",disabled,onClick: onUnstage },
    { label: "Discard...",disabled,danger: true,onClick: onDiscard },
    { label: "",separator: true },
    ...gitFileMenuItems(entries.map((entry) => ({
      repoRoot: entry.repoRoot, repoName: entry.repoName, path: entry.change.path,
    })), contextTarget),
  ];
}

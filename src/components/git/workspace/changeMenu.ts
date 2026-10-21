import { type MenuItem } from "../../ContextMenu";


export function workspaceChangeMenuItems({
  entries,
  onStage,
  onUnstage,
  onDiscard,
}: {
  entries: Array<{
    repoRoot: string;
    repoName: string;
    change: { path: string; };
  }>;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}): MenuItem[] {
  const disabled=entries.length===0;
  const copy=(text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => { });
  };
  const absolutePaths=entries.map((entry) => {
    const sep=entry.repoRoot.includes("\\")? "\\":"/";
    return `${entry.repoRoot}${sep}${entry.change.path.split("/").join(sep)}`;
  });
  const relativePaths=entries.map((entry) => (
    entries.length>1? `${entry.repoName}: ${entry.change.path}`:entry.change.path
  ));
  return [
    { label: "Stage",disabled,onClick: onStage },
    { label: "Unstage",disabled,onClick: onUnstage },
    { label: "Discard...",disabled,danger: true,onClick: onDiscard },
    { label: "",separator: true },
    {
      label: entries.length>1? `Copy paths (${entries.length})`:"Copy path",
      disabled,
      onClick: () => copy(absolutePaths.join("\n")),
    },
    {
      label: "Copy relative path",
      disabled,
      onClick: () => copy(relativePaths.join("\n")),
    },
  ];
}

import { type GitLogEntry,type GitResetMode } from "../../../lib/git";
import { type MenuItem } from "../../ContextMenu";


export function changeMenuItems(opts: {
  repoRoot: string;
  opPaths: string[];
  conflicted: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onShowDiff: () => void;
  onShowHistory: () => void;
  onAcceptOurs: () => void;
  onAcceptTheirs: () => void;
  onMarkResolved: () => void;
}): MenuItem[] {
  const { repoRoot,opPaths,conflicted,onStage,onUnstage,onDiscard,onShowDiff }=opts;
  const sep=repoRoot.includes("\\")? "\\":"/";
  const copy=(text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => { });
  };
  const disabled=opPaths.length===0;
  const items: MenuItem[]=[
    { label: "Show diff",disabled,onClick: onShowDiff },
    { label: "Show history",disabled: opPaths.length!==1,onClick: opts.onShowHistory },
  ];
  if(conflicted) {
    items.push(
      { label: "",separator: true },
      { label: "Accept ours",onClick: opts.onAcceptOurs },
      { label: "Accept theirs",onClick: opts.onAcceptTheirs },
      { label: "Mark resolved",onClick: opts.onMarkResolved },
    );
  }
  items.push(
    { label: "",separator: true },
    { label: "Stage",disabled,onClick: onStage },
    { label: "Unstage",disabled,onClick: onUnstage },
    { label: "Discard…",disabled,danger: true,onClick: onDiscard },
    { label: "",separator: true },
    {
      label: opPaths.length>1? `Copy paths (${opPaths.length})`:"Copy path",
      disabled,
      onClick: () => copy(opPaths.map((p) => `${repoRoot}${sep}${p.split("/").join(sep)}`).join("\n")),
    },
    { label: "Copy relative path",disabled,onClick: () => copy(opPaths.join("\n")) },
  );
  return items;
}


export function commitMenuItems(
  entry: GitLogEntry,
  handlers: {
    onCherryPick: (e: GitLogEntry) => void;
    onRevert: (e: GitLogEntry) => void;
    onReset: (e: GitLogEntry,mode: GitResetMode) => void;
    onNewBranch: (e: GitLogEntry) => void;
  },
): MenuItem[] {
  const copy=(text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => { });
  };
  const message=[entry.subject,entry.body.trim()].filter(Boolean).join("\n\n");
  return [
    { label: "Cherry-pick",onClick: () => handlers.onCherryPick(entry) },
    { label: "Revert",onClick: () => handlers.onRevert(entry) },
    {
      label: "Reset current branch to here",
      children: [
        { label: "Soft",onClick: () => handlers.onReset(entry,"soft") },
        { label: "Mixed",onClick: () => handlers.onReset(entry,"mixed") },
        { label: "Hard",danger: true,onClick: () => handlers.onReset(entry,"hard") },
      ],
    },
    { label: "New branch here…",onClick: () => handlers.onNewBranch(entry) },
    { label: "",separator: true },
    { label: "Copy revision hash",onClick: () => copy(entry.oid) },
    { label: "Copy subject",onClick: () => copy(entry.subject) },
    { label: "Copy message",onClick: () => copy(message) },
  ];
}

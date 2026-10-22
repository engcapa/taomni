import { useMemo,useState,type MouseEvent as ReactMouseEvent } from "react";
import { Group as PanelGroup,Panel,Separator as PanelResizeHandle } from "react-resizable-panels";
import { type GitBlobPair,type GitChange } from "../../../lib/git";
import { ChangesTree } from "../ChangesTree";
import {
  ChangesListToolbar,
  emptyGitChangeFilters,
  gitChangeMatchesFilters,
  hasActiveGitChangeFilters,
  type GitChangeFilters,
  type GitStageFilter,
  type GitStatusFilter,
} from "../shared/ChangesListToolbar";
import { CommitBar } from "../shared/CommitBar";
import { DiffPane as ChangesDiffPane } from "../shared/DiffPane";
import { useT } from "../../../lib/i18n";
import { gitChangeMatchesSearch,toggleSetValue } from "./model";


export function ChangesView({
  changes,
  treeMode,
  setTreeMode,
  checked,
  checkedCount,
  selected,
  activePath,
  onToggleChecked,
  onSelect,
  onContextMenu,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  amendChecked,
  setAmendChecked,
  busy,
  hasRemote,
  stagePaths,
  unstagePaths,
  discardPaths,
  commit,
  commitAndPush,
}: {
  changes: GitChange[];
  treeMode: boolean;
  setTreeMode: (value: boolean) => void;
  checked: Set<string>;
  checkedCount: number;
  selected: Set<string>;
  activePath: string|null;
  onToggleChecked: (paths: string[],value: boolean) => void;
  onSelect: (path: string,mods: { ctrl: boolean; shift: boolean; }) => void;
  onContextMenu: (path: string,event: ReactMouseEvent) => void;
  pair: GitBlobPair|null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  amendChecked: boolean;
  setAmendChecked: (value: boolean) => void;
  busy: boolean;
  hasRemote: boolean;
  stagePaths: (paths: string[]) => void;
  unstagePaths: (paths: string[]) => void;
  discardPaths: (paths: string[]) => void;
  commit: () => void;
  commitAndPush: () => void;
}) {
  const t=useT();
  const [filter,setFilter]=useState("");
  const [changeFilters,setChangeFilters]=useState<GitChangeFilters>(() => emptyGitChangeFilters());
  const normalizedFilter=filter.trim().toLowerCase();
  const visibleChanges=useMemo(() => (
    changes.filter((change) => (
      gitChangeMatchesFilters(change,changeFilters)
      &&gitChangeMatchesSearch(change,normalizedFilter)
    ))
  ),[changeFilters,changes,normalizedFilter]);
  const visiblePaths=useMemo(() => visibleChanges.map((change) => change.path),[visibleChanges]);
  const visibleStagedPaths=useMemo(
    () => visibleChanges.filter((change) => change.staged).map((change) => change.path),
    [visibleChanges],
  );
  const hasActiveFilters=hasActiveGitChangeFilters(changeFilters);
  const toggleStageFilter=(filterKey: GitStageFilter) => {
    setChangeFilters((current) => ({
      ...current,
      stage: toggleSetValue(current.stage,filterKey),
    }));
  };
  const toggleStatusFilter=(filterKey: GitStatusFilter) => {
    setChangeFilters((current) => ({
      ...current,
      status: toggleSetValue(current.status,filterKey),
    }));
  };
  const clearChangeFilters=() => {
    setChangeFilters(emptyGitChangeFilters());
  };
  const active=changes.find((change) => change.path===activePath)??null;
  const canCommit=!busy&&checkedCount>0&&!!commitMessage.trim();
  return (
    <PanelGroup orientation="horizontal" id="git-changes-layout">
      <Panel id="changes-list" defaultSize="36%" minSize="24%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <ChangesListToolbar
          busy={busy}
          filter={filter}
          onFilterChange={setFilter}
          filters={changeFilters}
          onToggleStageFilter={toggleStageFilter}
          onToggleStatusFilter={toggleStatusFilter}
          onClearFilters={clearChangeFilters}
          checkedCount={checkedCount}
          totalCount={changes.length}
          visibleCount={visibleChanges.length}
          visibleStagedCount={visibleStagedPaths.length}
          treeMode={treeMode}
          onCheckVisible={() => onToggleChecked(visiblePaths,true)}
          onUncheckVisible={() => onToggleChecked(visiblePaths,false)}
          onStageVisible={() => stagePaths(visiblePaths)}
          onUnstageVisible={() => unstagePaths(visibleStagedPaths)}
          onToggleTreeMode={() => setTreeMode(!treeMode)}
        />
        <ChangesTree
          changes={visibleChanges}
          treeMode={treeMode}
          emptyLabel={normalizedFilter||hasActiveFilters
            ? t("git.workspaceChanges.noMatchingChanges")
            :t("git.workspaceChanges.noLocalChanges")}
          checked={checked}
          onToggleChecked={onToggleChecked}
          busy={busy}
          onStagePaths={stagePaths}
          onUnstagePaths={unstagePaths}
          selected={selected}
          activePath={activePath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
        <CommitBar
          message={commitMessage}
          onMessageChange={setCommitMessage}
          canCommit={canCommit}
          canCommitAndPush={canCommit&&hasRemote}
          onCommit={commit}
          onCommitAndPush={commitAndPush}
          commitLabel={`Commit${checkedCount? ` (${checkedCount})`:""}`}
          amend={{ checked: amendChecked,onChange: setAmendChecked }}
        />
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="changes-diff" defaultSize="64%" minSize="35%" className="min-w-0 min-h-0 flex flex-col">
        <ChangesDiffPane
          title={active?.path??t("git.workspaceChanges.diffTitle")}
          busy={busy}
          selectedCount={active? 1:0}
          pair={pair}
          pairLoading={pairLoading}
          onStage={() => {
            if(activePath) stagePaths([activePath]);
          }}
          onUnstage={() => {
            if(activePath) unstagePaths([activePath]);
          }}
          onDiscard={() => {
            if(activePath) discardPaths([activePath]);
          }}
        />
      </Panel>
    </PanelGroup>
  );
}

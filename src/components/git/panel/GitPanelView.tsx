import { AlertTriangle, Braces, Download, Ellipsis, GitBranch, GitFork, GitMerge, Loader2, Plus, RefreshCcw, RefreshCw, Upload } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { promptAppDialog } from "../../../lib/appDialogs";
import {
  gitCheckoutTag,
  gitCherryPick,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteRemote,
  gitDeleteTag,
  gitFetch,
  gitMergeBranch,
  gitOperationAbort,
  gitOperationContinue,
  gitPull,
  gitPush,
  gitPushTag,
  gitRebaseSkip,
  gitRenameBranch,
  gitReset,
  gitRevert,
  gitSaveRemoteAuth,
  gitSaveSettings,
  gitSetRemote,
  gitSetUpstream,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashSave,
  gitUnstage,
  type GitBlobPair,
  type GitBranch as GitBranchInfo,
  type GitLogEntry,
  type GitOperationState,
  type GitRepoSettings,
  type GitSnapshot,
  type GitStashEntry,
} from "../../../lib/git";
import { rememberRecentBranch } from "../../../lib/gitRefList";
import { ContextMenu } from "../../ContextMenu";
import { CommitLog } from "../CommitLog";
import { CompareView } from "../CompareView";
import { BranchesView } from "./BranchesView";
import { ChangesView } from "./ChangesView";
import { SettingsView, WorkspaceSettingsSwitcher } from "./SettingsView";
import { StashView } from "./StashView";
import { TagsView } from "./TagsView";
import { BranchBadge, IconButton } from "./controls";
import { changeMenuItems, commitMenuItems } from "./menus";
import { operationLabel, pullBranchForRemote, type GitView, type RemoteDraft } from "./model";
import { checkoutBranch, confirmAndRun } from "./operationActions";

export interface GitPanelViewProps {
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  embedded: boolean;
  repoRoot: string;
  repoName: string;
  workspaceHeader: { title: string; summary: string; selectedRepoName: string; selectedRepoRoot: string; repoSelector?: ReactNode; branchBadge?: ReactNode; changeSummary?: ReactNode; actionControls?: ReactNode; } | undefined;
  snapshot: GitSnapshot | null;
  displayedChangeCount: number | null;
  remoteName: string;
  setRemoteName: import("react").Dispatch<import("react").SetStateAction<string>>;
  busy: boolean;
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
  setHeaderMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; } | null>>;
  loading: boolean;
  refresh: () => Promise<void>;
  view: GitView;
  switchView: (next: GitView) => void;
  error: string | null;
  operation: GitOperationState | null;
  hasConflicts: boolean;
  compare: { refA: string; refB: string; title: string; } | null;
  setCompare: import("react").Dispatch<import("react").SetStateAction<{ refA: string; refB: string; title: string; } | null>>;
  historyPath: string | null;
  setHistoryPath: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setCommitMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; entry: GitLogEntry; } | null>>;
  mountedViews: Set<GitView>;
  changesView: ReactNode;
  changesList: import("../../../lib/git").GitChange[];
  treeMode: boolean;
  setTreeMode: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  checked: Set<string>;
  checkedPaths: string[];
  selected: Set<string>;
  selectedPath: string | null;
  toggleChecked: (paths: string[], value: boolean) => void;
  handleSelect: (path: string, mods: { ctrl: boolean; shift: boolean; }) => void;
  openMenu: (path: string, event: ReactMouseEvent) => void;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: import("react").Dispatch<import("react").SetStateAction<string>>;
  amendChecked: boolean;
  setAmendChecked: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  discardPaths: (paths: string[]) => void;
  doCommit: (push: boolean) => void;
  workspaceLogView: ReactNode;
  workspaceBranchesView: ReactNode;
  selectedBranch: GitBranchInfo | null;
  setSelectedBranch: import("react").Dispatch<import("react").SetStateAction<GitBranchInfo | null>>;
  workspaceTagsView: ReactNode;
  selectedStash: GitStashEntry | null;
  setSelectedStash: import("react").Dispatch<import("react").SetStateAction<GitStashEntry | null>>;
  diff: string;
  diffLoading: boolean;
  includeUntracked: boolean;
  setIncludeUntracked: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  workspaceSettingsAggregateView: ReactNode | ((showCurrent: () => void) => ReactNode);
  workspaceSettingsView: ReactNode;
  settingsDraft: GitRepoSettings;
  setSettingsDraft: import("react").Dispatch<import("react").SetStateAction<GitRepoSettings>>;
  remoteDrafts: Record<string, RemoteDraft>;
  setRemoteDrafts: import("react").Dispatch<import("react").SetStateAction<Record<string, RemoteDraft>>>;
  headerMenu: { x: number; y: number; } | null;
  syncCurrentBranch: () => void;
  checkoutBranchByName: () => void;
  createBranchFromHead: () => void;
  onOpenWorkspace: ((repoRoot: string) => void) | undefined;
  forcePushCurrentBranch: () => void;
  menu: { x: number; y: number; path: string; } | null;
  setMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; path: string; } | null>>;
  opPaths: string[];
  stageSelected: () => 0 | Promise<void>;
  unstageSelected: () => 0 | Promise<void>;
  discardSelected: () => void;
  setSelectedPath: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  resolveConflict: (side: "ours" | "theirs") => void;
  markResolved: () => 0 | Promise<void>;
  commitMenu: { x: number; y: number; entry: GitLogEntry; } | null;
}

export function GitPanelView(inputs: GitPanelViewProps) {
  const {
    rootRef,
    embedded,
    repoRoot,
    repoName,
    workspaceHeader,
    snapshot,
    displayedChangeCount,
    remoteName,
    setRemoteName,
    busy,
    runAction,
    setHeaderMenu,
    loading,
    refresh,
    view,
    switchView,
    error,
    operation,
    hasConflicts,
    compare,
    setCompare,
    historyPath,
    setHistoryPath,
    setCommitMenu,
    mountedViews,
    changesView,
    changesList,
    treeMode,
    setTreeMode,
    checked,
    checkedPaths,
    selected,
    selectedPath,
    toggleChecked,
    handleSelect,
    openMenu,
    pair,
    pairLoading,
    commitMessage,
    setCommitMessage,
    amendChecked,
    setAmendChecked,
    discardPaths,
    doCommit,
    workspaceLogView,
    workspaceBranchesView,
    selectedBranch,
    setSelectedBranch,
    workspaceTagsView,
    selectedStash,
    setSelectedStash,
    diff,
    diffLoading,
    includeUntracked,
    setIncludeUntracked,
    workspaceSettingsAggregateView,
    workspaceSettingsView,
    settingsDraft,
    setSettingsDraft,
    remoteDrafts,
    setRemoteDrafts,
    headerMenu,
    syncCurrentBranch,
    checkoutBranchByName,
    createBranchFromHead,
    onOpenWorkspace,
    forcePushCurrentBranch,
    menu,
    setMenu,
    opPaths,
    stageSelected,
    unstageSelected,
    discardSelected,
    setSelectedPath,
    resolveConflict,
    markResolved,
    commitMenu,
  } = inputs;
  return ((
    <div
      ref={rootRef}
      data-testid="git-panel"
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className={`${embedded ? "h-9 px-2" : "h-10 px-3"} shrink-0 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]`}>
        {embedded ? (
          <span className="max-w-40 truncate text-[11px] text-[var(--taomni-text-muted)]" title={repoRoot}>
            {repoName}
          </span>
        ) : workspaceHeader ? (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            {workspaceHeader.repoSelector ? (
              <>
                <span className="shrink-0 font-semibold leading-4">Git</span>
                {workspaceHeader.repoSelector}
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="font-semibold leading-4 truncate">Workspace Git · {workspaceHeader.title}</div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{workspaceHeader.summary}</div>
                </div>
                <span className="taomni-divider-v h-5 mx-1" />
                <span
                  className="inline-flex items-center gap-1 h-6 max-w-56 rounded bg-[var(--taomni-hover)] px-2 text-[11px]"
                  title={workspaceHeader.selectedRepoRoot}
                >
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">Repository detail</span>
                  <span className="min-w-0 truncate font-medium">{workspaceHeader.selectedRepoName}</span>
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            <div className="min-w-0">
              <div className="font-semibold leading-4 truncate">Git · {repoName}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{repoRoot}</div>
            </div>
            <span className="taomni-divider-v h-5 mx-1" />
          </>
        )}
        {workspaceHeader?.branchBadge ?? <BranchBadge snapshot={snapshot} />}
        {workspaceHeader?.changeSummary ?? (displayedChangeCount !== null && (
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {displayedChangeCount} changes
            {snapshot && (snapshot.ahead || snapshot.behind) ? ` · ↑${snapshot.ahead} ↓${snapshot.behind}` : ""}
          </span>
        ))}
        <div className="flex-1" />
        {workspaceHeader?.actionControls ?? (
          <>
            <select
              className="taomni-input h-7 w-32"
              value={remoteName}
              onChange={(event) => setRemoteName(event.target.value)}
              disabled={!snapshot?.remotes.length}
            >
              {snapshot?.remotes.length ? snapshot.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>{remote.name}</option>
              )) : <option value="">No remote</option>}
            </select>
            <IconButton label="Fetch" icon={<Download className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Fetch", () => gitFetch(repoRoot, remoteName))} />
            <IconButton label="Pull" icon={<GitMerge className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Pull", () => gitPull(repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName)))} />
            <IconButton label="Push" icon={<Upload className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Push", () => gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream))} />
            <button
              type="button"
              className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
              title="More Git actions"
              aria-label="More Git actions"
              onClick={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}
            >
              <Ellipsis className="w-3.5 h-3.5 text-[var(--taomni-text)]" />
            </button>
            <IconButton label="Refresh" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={() => void refresh()} />
          </>
        )}
      </header>

      <nav className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--taomni-divider)]">
        {(["changes", "log", "branches", "tags", "stash", "settings"] as GitView[]).map((item) => (
          <button
            key={item}
            type="button"
            data-testid={item === "log" ? "git-log-tab" : undefined}
            className={`h-7 px-3 rounded text-[12px] capitalize ${view === item ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => switchView(item)}
          >
            {item}
          </button>
        ))}
        {(busy || loading) && <Loader2 className="w-3.5 h-3.5 animate-spin ml-1" />}
        {error && <span className="ml-2 text-[11px] text-red-500 truncate">{error}</span>}
      </nav>

      {(operation && operation.kind !== "none") || hasConflicts ? (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px]">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="min-w-0">
            {operationLabel(operation)}
            {operation?.conflictedPaths.length
              ? ` — ${operation.conflictedPaths.length} conflicted file(s). Resolve and stage them, then continue.`
              : " Resolve conflicts, stage them, then continue or abort."}
          </span>
          <div className="flex-1" />
          {operation && operation.kind !== "none" ? (
            <>
              <button
                className="taomni-btn h-7 px-2"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Continue ${operation.kind}`, () => gitOperationContinue(repoRoot, operation.kind))}
              >
                Continue
              </button>
              {operation.kind === "rebase" && (
                <button
                  className="taomni-btn h-7 px-2"
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction("Skip", () => gitRebaseSkip(repoRoot))}
                >
                  Skip
                </button>
              )}
              <button
                className="taomni-btn h-7 px-2 text-red-500"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Abort ${operation.kind}`, () => gitOperationAbort(repoRoot, operation.kind))}
              >
                Abort
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <main className="flex-1 min-h-0">
        {compare ? (
          <CompareView
            repoRoot={repoRoot}
            refA={compare.refA}
            refB={compare.refB}
            title={compare.title}
            onClose={() => setCompare(null)}
          />
        ) : historyPath ? (
          <CommitLog
            repoRoot={repoRoot}
            headOid={snapshot?.headOid ?? null}
            branches={snapshot?.branches ?? []}
            busy={busy}
            pathFilter={historyPath}
            onClose={() => setHistoryPath(null)}
            onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
          />
        ) : (
          <>
            {mountedViews.has("changes") && (
              <div className="h-full min-h-0" style={{ display: view === "changes" ? "block" : "none" }}>
                {changesView ?? (
                  <ChangesView
                    changes={changesList}
                    treeMode={treeMode}
                    setTreeMode={setTreeMode}
                    checked={checked}
                    checkedCount={checkedPaths.length}
                    selected={selected}
                    activePath={selectedPath}
                    onToggleChecked={toggleChecked}
                    onSelect={handleSelect}
                    onContextMenu={openMenu}
                    pair={pair}
                    pairLoading={pairLoading}
                    commitMessage={commitMessage}
                    setCommitMessage={setCommitMessage}
                    amendChecked={amendChecked}
                    setAmendChecked={setAmendChecked}
                    busy={busy}
                    hasRemote={!!remoteName}
                    stagePaths={(paths) => {
                      if (paths.length) void runAction("Stage", () => gitStage(repoRoot, paths));
                    }}
                    unstagePaths={(paths) => {
                      if (paths.length) void runAction("Unstage", () => gitUnstage(repoRoot, paths));
                    }}
                    discardPaths={discardPaths}
                    commit={() => doCommit(false)}
                    commitAndPush={() => doCommit(true)}
                  />
                )}
              </div>
            )}
            {mountedViews.has("log") && (
              <div className="h-full min-h-0 git-log-view" style={{ display: view === "log" ? "block" : "none" }}>
                {workspaceLogView ?? (
                  <CommitLog
                    repoRoot={repoRoot}
                    headOid={snapshot?.headOid ?? null}
                    branches={snapshot?.branches ?? []}
                    busy={busy}
                    onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
                  />
                )}
              </div>
            )}
            {mountedViews.has("branches") && (
              <div className="h-full min-h-0" style={{ display: view === "branches" ? "block" : "none" }}>
                {workspaceBranchesView ?? <BranchesView
                  snapshot={snapshot}
                  selected={selectedBranch}
                  setSelected={setSelectedBranch}
                  busy={busy}
                  onCreate={async () => {
                    const name = await promptAppDialog({ title: "Create branch", label: "Branch name" });
                    if (name) {
                      await runAction("Create branch", async () => {
                        await gitCreateBranch(repoRoot, name, selectedBranch?.name ?? null, true);
                        rememberRecentBranch(repoRoot, name);
                      });
                    }
                  }}
                  onCheckout={(branch) => void checkoutBranch(repoRoot, branch, runAction)}
                  onMerge={(branch) => void confirmAndRun("Merge branch", `Merge ${branch.name} into current branch?`, false, () => runAction("Merge", () => gitMergeBranch(repoRoot, branch.name)))}
                  onDelete={(branch) => void confirmAndRun("Delete branch", `Delete local branch ${branch.name}?`, true, () => runAction("Delete branch", () => gitDeleteBranch(repoRoot, branch.name, false)))}
                  onRename={async (branch) => {
                    const next = await promptAppDialog({ title: "Rename branch", label: "New name", initialValue: branch.name });
                    if (next && next !== branch.name) {
                      await runAction("Rename branch", async () => {
                        await gitRenameBranch(repoRoot, branch.name, next);
                        rememberRecentBranch(repoRoot, next);
                      });
                    }
                  }}
                  onPush={(branch) => void runAction("Push branch", () => gitPush(repoRoot, remoteName || null, branch.name, !branch.upstream))}
                  onSetUpstream={async (branch) => {
                    const up = await promptAppDialog({
                      title: "Set upstream",
                      label: "Upstream (remote/branch, empty to clear)",
                      initialValue: branch.upstream ?? `${remoteName || "origin"}/${branch.name}`,
                      allowEmpty: true,
                    });
                    if (up !== null) await runAction("Set upstream", () => gitSetUpstream(repoRoot, branch.name, up || null));
                  }}
                  onCompare={(branch) => {
                    if (!snapshot?.currentBranch) return;
                    setCompare({ refA: branch.name, refB: snapshot.currentBranch, title: `${branch.name} → ${snapshot.currentBranch}` });
                  }}
                />}
              </div>
            )}
            {mountedViews.has("tags") && (
              <div className="h-full min-h-0" style={{ display: view === "tags" ? "block" : "none" }}>
                {workspaceTagsView ?? <TagsView
                  snapshot={snapshot}
                  busy={busy}
                  hasRemote={!!remoteName}
                  onCreate={async () => {
                    const name = await promptAppDialog({ title: "Create tag", label: "Tag name" });
                    if (!name) return;
                    const message = await promptAppDialog({ title: "Create tag", label: "Annotation message (empty = lightweight)", allowEmpty: true });
                    await runAction("Create tag", () => gitCreateTag(repoRoot, name, null, message || null));
                  }}
                  onCheckout={(tag) => void confirmAndRun("Checkout tag", `Checkout ${tag.name}? This detaches HEAD.`, false, () => runAction("Checkout tag", () => gitCheckoutTag(repoRoot, tag.name)))}
                  onDelete={(tag) => void confirmAndRun("Delete tag", `Delete tag ${tag.name}?`, true, () => runAction("Delete tag", () => gitDeleteTag(repoRoot, tag.name)))}
                  onPush={(tag) => void runAction("Push tag", () => gitPushTag(repoRoot, remoteName || null, tag.name, false))}
                />}
              </div>
            )}
            {mountedViews.has("stash") && (
              <div className="h-full min-h-0" style={{ display: view === "stash" ? "block" : "none" }}>
                <StashView
                  snapshot={snapshot}
                  selected={selectedStash}
                  setSelected={setSelectedStash}
                  diff={diff}
                  diffLoading={diffLoading}
                  busy={busy}
                  includeUntracked={includeUntracked}
                  setIncludeUntracked={setIncludeUntracked}
                  onSave={async () => {
                    const message = await promptAppDialog({ title: "Stash changes", label: "Message", allowEmpty: true });
                    if (message !== null) await runAction("Stash", () => gitStashSave(repoRoot, message, includeUntracked));
                  }}
                  onApply={() => selectedStash && void runAction("Apply stash", () => gitStashApply(repoRoot, selectedStash.selector, false))}
                  onPop={() => selectedStash && void runAction("Pop stash", () => gitStashApply(repoRoot, selectedStash.selector, true))}
                  onDrop={() => selectedStash && void confirmAndRun("Drop stash", `Drop ${selectedStash.selector}?`, true, () => runAction("Drop stash", () => gitStashDrop(repoRoot, selectedStash.selector)))}
                />
              </div>
            )}
            {mountedViews.has("settings") && (
              <div className="h-full min-h-0" style={{ display: view === "settings" ? "block" : "none" }}>
                <WorkspaceSettingsSwitcher
                  aggregateView={workspaceSettingsAggregateView}
                  currentView={workspaceSettingsView ?? <SettingsView
                    snapshot={snapshot}
                    settings={settingsDraft}
                    setSettings={setSettingsDraft}
                    remoteDrafts={remoteDrafts}
                    setRemoteDrafts={setRemoteDrafts}
                    busy={busy}
                    onSaveSettings={() => void runAction("Save Git settings", () => gitSaveSettings(repoRoot, settingsDraft))}
                    onSaveRemote={(remote, draft) => void runAction("Save remote", async () => {
                      await gitSetRemote(repoRoot, draft.name || remote.name, draft.fetchUrl, draft.pushUrl);
                      await gitSaveRemoteAuth(repoRoot, draft.name || remote.name, draft.username, draft.token, false);
                      setRemoteDrafts({ ...remoteDrafts, [remote.name]: { ...draft, token: "" } });
                    })}
                    onClearToken={(remote) => void runAction("Clear remote token", async () => {
                      await gitSaveRemoteAuth(repoRoot, remote.name, remoteDrafts[remote.name]?.username ?? remote.username, null, true);
                    })}
                    onDeleteRemote={(remote) => void confirmAndRun("Delete remote", `Delete remote ${remote.name}?`, true, () => runAction("Delete remote", () => gitDeleteRemote(repoRoot, remote.name)))}
                    onAddRemote={async () => {
                      const name = await promptAppDialog({ title: "Add remote", label: "Remote name", initialValue: "origin" });
                      if (!name) return;
                      const url = await promptAppDialog({ title: "Add remote", label: "Remote URL" });
                      if (!url) return;
                      await runAction("Add remote", () => gitSetRemote(repoRoot, name, url, null));
                    }}
                  />}
                />
              </div>
            )}
          </>
        )}
      </main>
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              label: "Sync",
              icon: <RefreshCcw className="w-3.5 h-3.5" />,
              disabled: busy || !remoteName,
              onClick: syncCurrentBranch,
            },
            {
              label: "Checkout branch...",
              icon: <GitFork className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: checkoutBranchByName,
            },
            {
              label: "New branch...",
              icon: <Plus className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: createBranchFromHead,
            },
            {
              label: "Open code workspace",
              icon: <Braces className="w-3.5 h-3.5" />,
              disabled: !onOpenWorkspace,
              onClick: () => onOpenWorkspace?.(repoRoot),
            },
            { label: "", separator: true },
            {
              label: "Force push with lease...",
              icon: <Upload className="w-3.5 h-3.5" />,
              disabled: busy || !remoteName || !snapshot?.currentBranch,
              danger: true,
              onClick: forcePushCurrentBranch,
            },
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={changeMenuItems({
            repoRoot,
            opPaths,
            conflicted: changesList.some((c) => opPaths.includes(c.path) && c.conflict),
            onStage: stageSelected,
            onUnstage: unstageSelected,
            onDiscard: discardSelected,
            onShowDiff: () => setSelectedPath(menu.path),
            onShowHistory: () => setHistoryPath(menu.path),
            onAcceptOurs: () => resolveConflict("ours"),
            onAcceptTheirs: () => resolveConflict("theirs"),
            onMarkResolved: markResolved,
          })}
        />
      )}
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={commitMenuItems(commitMenu.entry, {
            onCherryPick: (e) =>
              void confirmAndRun("Cherry-pick", `Cherry-pick ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Cherry-pick", () => gitCherryPick(repoRoot, e.oid))),
            onRevert: (e) =>
              void confirmAndRun("Revert commit", `Revert ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Revert", () => gitRevert(repoRoot, e.oid))),
            onReset: (e, mode) =>
              void confirmAndRun(`Reset ${mode}`, `Reset current branch to ${e.shortOid} using --${mode}? `, mode === "hard", () =>
                runAction("Reset", () => gitReset(repoRoot, e.oid, mode))),
            onNewBranch: async (e) => {
              const name = await promptAppDialog({ title: "New branch from commit", label: "Branch name" });
              if (name) await runAction("Create branch", () => gitCreateBranch(repoRoot, name, e.oid, true));
            },
          })}
        />
      )}
    </div>
  ));
}

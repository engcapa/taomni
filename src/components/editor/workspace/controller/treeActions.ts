import { workspaceListDir } from "../../../../lib/editor/workspace";
import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { PlanTemplateCreationResult } from "../fileTemplateModel";
import { writeText } from "../../../../lib/clipboard";
import { workspaceEditApplyResponse } from "../workspaceEditApply";
import type { MenuItem } from "../../../ContextMenu";
import { useProjectFactsStore } from "../../../../stores/projectFactsStore";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, type TreeSelection, type WorkspaceTreeCommandPayload, errorMessage, normalizeFsPath, parentPath, relativePathWithinRoot, rootDirKey, shouldHideEntry } from "../codeWorkspaceModel";
import { type BreadcrumbPathAction, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "../Breadcrumbs";
import { type WorkspaceEditApplyOptions } from "./mutationTypes";



export interface LoadBreadcrumbPathChildrenContext {
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  loadDir: (rootId: string, path: string) => Promise<void>;
}


export function createLoadBreadcrumbPathChildren(controllerContext: LoadBreadcrumbPathChildrenContext): (segment: BreadcrumbPathSegment, file: OpenFileState, trail: BreadcrumbPathSegment[]) => Promise<BreadcrumbPathChild[]> {
  return async (
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
    trail: BreadcrumbPathSegment[],
  ): Promise<BreadcrumbPathChild[]> => {
    const segmentIndex = trail.findIndex((item) =>
      item.path === segment.path && item.kind === segment.kind && item.label === segment.label
    );
    // Nothing to browse inside a JAR / decompiled class.
    if (file.library) return [];
    const nextSegment = segmentIndex >= 0 ? trail[segmentIndex + 1] ?? null : null;
    const activeChildPath = nextSegment && nextSegment.kind !== "root" ? nextSegment.path : null;

    const toChildren = (
      entries: Array<{ name: string; path: string; fileType: string; isHidden?: boolean }>,
      pathOf: (entry: { name: string; path: string }) => string,
    ): BreadcrumbPathChild[] => entries
      .filter((entry) => entry.fileType === "file" || entry.fileType === "dir")
      .filter((entry) => !shouldHideEntry({
        name: entry.name,
        path: entry.path,
        fileType: entry.fileType as "file" | "dir" | "symlink" | "other",
        size: 0,
        mtime: 0,
        isHidden: entry.isHidden ?? false,
      }))
      .map((entry) => {
        const path = pathOf(entry);
        const kind = entry.fileType === "dir" ? "directory" as const : "file" as const;
        return {
          label: entry.name,
          path,
          kind,
          active: activeChildPath === path,
        };
      });

    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = controllerContext.rootsRef.current.find((item) => item.id === rootId);
      if (!root) return [];
      // File segment → siblings in parent; directory/root → children of that path.
      const listPath = segment.kind === "file" ? parentPath(segment.path) : segment.path;
      void controllerContext.loadDir(rootId, listPath);
      const result = await workspaceListDir(root.path, listPath);
      if (result.state !== "ready") return [];
      return toChildren([...result.entries], (entry) => entry.path);
    }

    // Loose file: list an absolute directory via workspace_list_dir(dir, "").
    const absolute = normalizeFsPath(segment.path);
    const dirToList = segment.kind === "file" ? parentPath(absolute) : absolute;
    if (!dirToList) return [];
    const result = await workspaceListDir(dirToList, "");
    if (result.state !== "ready") return [];
    return toChildren([...result.entries], (entry) =>
      normalizeFsPath(`${dirToList.replace(/[/\\]+$/, "")}/${entry.name}`)
    );
  };
}



export interface BreadcrumbPathActionsContext {
  setSelected: (selection: TreeSelection | null) => void;
  treePaneRef: import("react").RefObject<HTMLElement | null>;
  setExpandedRoots: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setExpandedDirs: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  loadDir: (rootId: string, path: string) => Promise<void>;
  revealEditorTabInTree: (key: string) => void;
  copyTreePath: (rootId: string, path: string, absolute: boolean) => Promise<void>;
  revealInExplorer: (rootId: string, path: string) => Promise<void>;
  setStatusMessage: (message: string) => void;
}


export function createBreadcrumbPathActions(controllerContext: BreadcrumbPathActionsContext): (segment: BreadcrumbPathSegment, file: OpenFileState) => BreadcrumbPathAction[] {
  return (
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
  ): BreadcrumbPathAction[] => {
    // Copy path / reveal / open-in-terminal make no sense for a class inside a JAR.
    if (file.library) return [];
    const actions: BreadcrumbPathAction[] = [];
    actions.push({
      id: "reveal-tree",
      label: "Select in Project Tree",
      onSelect: () => {
        if (file.ref.kind !== "root") {
          controllerContext.setSelected({ kind: "file", ref: file.ref });
          controllerContext.treePaneRef.current?.focus();
          return;
        }
        const rootId = file.ref.rootId;
        if (segment.kind === "root") {
          controllerContext.setSelected({ kind: "root", rootId });
          controllerContext.setExpandedRoots((current) => new Set(current).add(rootId));
        } else if (segment.kind === "directory") {
          controllerContext.setSelected({ kind: "dir", rootId, path: segment.path });
          controllerContext.setExpandedRoots((current) => new Set(current).add(rootId));
          controllerContext.setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
          void controllerContext.loadDir(rootId, segment.path);
        } else {
          controllerContext.setSelected({ kind: "file", ref: file.ref });
          controllerContext.revealEditorTabInTree(file.key);
          return;
        }
        controllerContext.treePaneRef.current?.focus();
      },
    });
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => { void controllerContext.copyTreePath(rootId, segment.path, true); },
      });
      actions.push({
        id: "copy-relative",
        label: "Copy Relative Path",
        onSelect: () => { void controllerContext.copyTreePath(rootId, segment.path, false); },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => { void controllerContext.revealInExplorer(rootId, segment.path); },
      });
    } else {
      const absolute = normalizeFsPath(segment.path);
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => {
          void writeText(absolute)
            .then(() => controllerContext.setStatusMessage(`Copied ${absolute}`))
            .catch((err) => controllerContext.setStatusMessage(errorMessage(err)));
        },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => {
          void invoke("sftp_open_path", { path: absolute })
            .then(() => controllerContext.setStatusMessage(`Opened ${absolute}`))
            .catch((err) => controllerContext.setStatusMessage(errorMessage(err)));
        },
      });
    }
    return actions;
  };
}



export interface ShowTreeContextMenuContext {
  setSelected: (selection: TreeSelection | null) => void;
  treeContextMenuSessionRef: import("react").RefObject<{ workspaceInstanceId: string; selection: TreeSelection | null; consumed: boolean; } | null>;
  workspaceInstanceId: string;
  workspaceCommandRunnerRef: import("react").RefObject<(commandId: string, context?: WorkspaceCommandContext) => boolean>;
  stageTreeClipboard: (mode: "copy" | "cut", rootId: string, path: string, isDirectory?: boolean) => void;
  canPasteTreeClipboard: () => boolean;
  pasteTreeClipboard: (target: { rootId: string; path: string; }) => Promise<void>;
  openTreeContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  setStatusMessage: (message: string) => void;
  revealInExplorer: (rootId: string, path: string) => Promise<void>;
  openTerminalAt: (rootId: string, path: string, pathIsFile?: boolean) => void;
}


export function createShowTreeContextMenu(controllerContext: ShowTreeContextMenuContext): (event: React.MouseEvent, selection: TreeSelection) => void {
  return (event: React.MouseEvent, selection: TreeSelection) => {
      controllerContext.setSelected(selection);
      controllerContext.treeContextMenuSessionRef.current = {
        workspaceInstanceId: controllerContext.workspaceInstanceId,
        selection,
        consumed: false,
      };
      const run = (commandId: string, payload: WorkspaceTreeCommandPayload) => () => {
        if (controllerContext.treeContextMenuSessionRef.current) {
          controllerContext.treeContextMenuSessionRef.current.consumed = true;
        }
        controllerContext.workspaceCommandRunnerRef.current(commandId, { focus: "tree", payload });
      };
      const clipboardItems = (
        rootId: string,
        path: string,
        directory: { rootId: string; path: string },
        isDirectory: boolean,
      ) => [
        {
          label: "Cut",
          onClick: () => controllerContext.stageTreeClipboard("cut", rootId, path, isDirectory),
        },
        {
          label: "Copy",
          onClick: () => controllerContext.stageTreeClipboard("copy", rootId, path, isDirectory),
        },
        {
          label: "Paste",
          disabled: !controllerContext.canPasteTreeClipboard(),
          onClick: () => void controllerContext.pasteTreeClipboard(directory),
        },
      ];
      if (selection.kind === "file") {
        if (selection.ref.kind === "loose") {
          const ref = selection.ref;
          const absolute = normalizeFsPath(ref.path);
          controllerContext.openTreeContextMenu(event, [
            { label: "Open", onClick: run("workspace.tree.open", { selection }) },
            { separator: true, label: "" },
            { label: "Copy Path", onClick: () => void writeText(absolute) },
            {
              label: "Reveal in Explorer",
              onClick: () => {
                void invoke("sftp_open_path", { path: absolute })
                  .then(() => controllerContext.setStatusMessage(`Opened ${absolute}`))
                  .catch((err) => controllerContext.setStatusMessage(errorMessage(err)));
              },
            },
          ]);
          return;
        }
        const ref = selection.ref;
        const dir = parentPath(ref.path);
        controllerContext.openTreeContextMenu(event, [
          { label: "Open", onClick: run("workspace.tree.open", { selection }) },
          { separator: true, label: "" },
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(ref.rootId, ref.path, { rootId: ref.rootId, path: dir }, false),
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: ref.rootId, path: ref.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: ref.rootId, path: ref.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void controllerContext.revealInExplorer(ref.rootId, ref.path),
          },
          { label: "Open in Terminal", onClick: () => controllerContext.openTerminalAt(ref.rootId, ref.path, true) },
        ]);
        return;
      }
      if (selection.kind === "dir") {
        controllerContext.openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(
            selection.rootId,
            selection.path,
            { rootId: selection.rootId, path: selection.path },
            true,
          ),
          { separator: true, label: "" },
          { label: "Find in Directory...", onClick: run("workspace.tree.findInDirectory", { path: selection.path }) },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: selection.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: selection.rootId, path: selection.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void controllerContext.revealInExplorer(selection.rootId, selection.path),
          },
          { label: "Open in Terminal", onClick: () => controllerContext.openTerminalAt(selection.rootId, selection.path) },
        ]);
        return;
      }
      if (selection.kind === "root") {
        controllerContext.openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "Rename Root...", onClick: run("workspace.tree.rename", { selection }) },
          { separator: true, label: "" },
          {
            label: "Paste",
            disabled: !controllerContext.canPasteTreeClipboard(),
            onClick: () => void controllerContext.pasteTreeClipboard({ rootId: selection.rootId, path: "" }),
          },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: "" }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void controllerContext.revealInExplorer(selection.rootId, ""),
          },
          { label: "Open in Terminal", onClick: () => controllerContext.openTerminalAt(selection.rootId, "") },
          { separator: true, label: "" },
          { label: "Remove from Workspace", danger: true, onClick: run("workspace.tree.delete", { selection }) },
        ]);
      }
    };
}



export interface CreateJavaClassFromPlanContext {
  newJavaClassDialogState: { open: boolean; targetDirectory: string; root: CodeWorkspaceRootInfo; dirRelPath: string; sourceRoots: readonly string[]; existingFiles: readonly string[]; projectFactsStatus: string; projectFactsGeneration: number; projectFactsFingerprint: string | null; } | null;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: WorkspaceEditApplyOptions) => Promise<import("../workspaceEditApply").WorkspaceEditApplyOutcome[]>;
  setStatusMessage: (message: string) => void;
  loadDir: (rootId: string, path: string) => Promise<void>;
  setSelected: (selection: TreeSelection | null) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
}


export function createCreateJavaClassFromPlan(controllerContext: CreateJavaClassFromPlanContext): (plan: PlanTemplateCreationResult & { valid: true; }) => Promise<boolean> {
  return async (
    plan: PlanTemplateCreationResult & { valid: true },
  ) => {
    if (!controllerContext.newJavaClassDialogState) return false;
    const {
      root,
      dirRelPath,
      projectFactsGeneration,
      projectFactsFingerprint,
    } = controllerContext.newJavaClassDialogState;

    const assertCurrentProjectFacts = () => {
      const currentFacts = useProjectFactsStore.getState().getWorkspaceFacts(root.path);
      const isCurrent = currentFacts.status === "ready"
        && !currentFacts.isStale
        && currentFacts.structure !== null
        && currentFacts.generation === projectFactsGeneration
        && currentFacts.fingerprint === projectFactsFingerprint;
      if (isCurrent) return;

      const reason = currentFacts.status === "ready"
        && !currentFacts.isStale
        && currentFacts.generation === projectFactsGeneration
        && currentFacts.fingerprint === projectFactsFingerprint
        ? "project facts are no longer ready"
        : "project facts changed";
      throw new Error(`Cannot create ${plan.className}.java: ${reason}`);
    };

    const relPath = relativePathWithinRoot(root.path, plan.targetPath) ?? `${plan.className}.java`;
    const edit: LspWorkspaceEdit = {
      operations: [
        {
          kind: "create",
          uri: "",
          path: plan.targetPath,
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        },
        {
          kind: "text",
          document: {
            uri: "",
            path: plan.targetPath,
            version: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: plan.content,
              },
            ],
          },
        },
      ],
      documentEdits: [
        {
          uri: "",
          path: plan.targetPath,
          version: null,
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: plan.content,
            },
          ],
        },
      ],
    };

    try {
      assertCurrentProjectFacts();
      const outcomes = await controllerContext.applyLspWorkspaceEdit(edit, {
        label: `Create ${plan.kind} ${plan.className}`,
        preflightMutation: assertCurrentProjectFacts,
      });
      const response = workspaceEditApplyResponse(outcomes);
      if (!response.applied) {
        controllerContext.setStatusMessage(
          `Could not create ${plan.className}.java: ${response.failureReason ?? "workspace edit was not applied"}`,
        );
        return false;
      }
      await controllerContext.loadDir(root.id, dirRelPath);
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relPath };
      controllerContext.setSelected({ kind: "file", ref });
      await controllerContext.openFile(ref);
      controllerContext.notifyWorkspacePathGitChanged(root.id, relPath);
      controllerContext.setStatusMessage(`Created ${plan.className}.java in ${plan.packageName || "(default package)"}`);
      return true;
    } catch (err) {
      controllerContext.setStatusMessage(errorMessage(err));
      return false;
    }
  };
}

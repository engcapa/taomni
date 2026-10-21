import { type WorkspaceFile } from "../../../../lib/editor/workspace";
import { lspBuildWorkspace, type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "../editorGroupTypes";
import { type SaveCommitResult } from "../saveCommit";
import { type ProblemsScope } from "../panels/ProblemsPanel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage } from "../codeWorkspaceModel";
import { isJavaBuildFile } from "./model";



export interface PrepareJavaLaunchContext {
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  saveOpenBufferText: (key: string, textToSave?: string, saveOptions?: { eol?: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: SaveCommitResult) => void) => Promise<WorkspaceFile | null>;
  setStatusMessage: (message: string) => void;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  lspDescriptorForPath: (rootPath: string | null, filePath: string, documentUri?: string | null) => LspDocumentDescriptor;
  setProblemsScope: import("react").Dispatch<import("react").SetStateAction<ProblemsScope>>;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  mountedRef: import("react").MutableRefObject<boolean>;
}


export function createPrepareJavaLaunch(controllerContext: PrepareJavaLaunchContext): (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean> {
  return async (
    rootId: string,
    launchDescriptor?: LspDocumentDescriptor | null,
  ): Promise<boolean> => {
    const root = controllerContext.findRoot(rootId);
    if (!root) return true;
    // Save every dirty file in this root that jdtls builds from: .java sources
    // and Maven/Gradle build descriptors. saveOpenBufferText awaits didSave so
    // jdtls receives it before the build barrier below.
    const dirty = Object.values(controllerContext.openFilesRef.current).filter((f) =>
      f.ref.kind === "root"
      && f.ref.rootId === rootId
      && f.dirty
      && !f.library
      && (f.languagePath.toLowerCase().endsWith(".java") || isJavaBuildFile(f.languagePath)),
    );
    for (const f of dirty) {
      try {
        await controllerContext.saveOpenBufferText(f.key, f.text);
      } catch (err) {
        const message = `Cannot start debug: failed to save ${f.subtitle}: ${errorMessage(err)}`;
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        return false;
      }
    }
    // Build barrier. Use the descriptor of the file being launched, NOT a
    // synthetic path at the root: the jdtls session key includes the SDK
    // resolver's `project_scope_path` (the nearest module walking up from the
    // file), so in a multi-module build a root-level path keys the aggregator
    // and misses the module session the launch itself uses — the build then
    // reports "no language server session is active" and gets skipped.
    // Incremental (full = false): jdtls autobuilds on save, so a clean rebuild
    // would add minutes to every debug start for no benefit.
    const descriptor = launchDescriptor
      ?? controllerContext.lspDescriptorForPath(root.path, "__taomni_debug_build__.java");
    controllerContext.debug.reportStartupProgress("Building project…");
    try {
      let status = await lspBuildWorkspace(descriptor, false);
      if (status === "withError") {
        // An incremental build can report stale compiler errors if files or dependencies
        // changed outside jdtls. Retry once with a clean rebuild before failing.
        controllerContext.debug.reportStartupProgress("Rebuilding project…");
        status = await lspBuildWorkspace(descriptor, true).catch(() => "withError" as const);
      }
      if (status === "failed") {
        // The build itself broke (infrastructure, not a compiler verdict). Say
        // so instead of launching stale bytecode.
        const message = "Cannot start debug: the project build failed";
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        return false;
      }
      if (status === "withError") {
        // jdtls compiled and reported errors: the compiler's own verdict. Show
        // them where they live instead of launching broken classes.
        const message = "Cannot start debug: the project compiled with errors";
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        controllerContext.setProblemsScope("project");
        controllerContext.setBottomDockTab("problems");
        controllerContext.setBottomDockOpen(true);
        return false;
      }
    } catch (err) {
      // No jdtls session / build unsupported: don't block. The adapter's own
      // main-class / classpath resolution will report a clear error if needed.
      controllerContext.debug.reportStartupProgress(`Skipping pre-launch build: ${errorMessage(err)}`);
      return true;
    }
    if (!controllerContext.mountedRef.current) return false;
    return true;
  };
}

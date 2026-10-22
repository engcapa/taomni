import { useCallback, useEffect, useState } from "react";
import { lspBuildWorkspace, lspWorkspaceDiagnostics, type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { type ProblemFileGroup, type ProblemsScope } from "../panels/ProblemsPanel";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { basename, errorMessage, relativePathWithinRoot } from "../codeWorkspaceModel";
import { LSP_DIAGNOSTICS_REFRESH_EVENT } from "../useWorkspaceLspSession";


export interface UseProjectDiagnosticsContext {
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  looseFilesRef: import("react").RefObject<CodeWorkspaceLooseFileInfo[]>;
  workspaceInstanceId: string;
  mountedRef: import("react").MutableRefObject<boolean>;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  inspectionPathForFileKey: (fileKeyValue: string) => string;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  lspDescriptorForPath: (rootPath: string | null, filePath: string, documentUri?: string | null) => LspDocumentDescriptor;
  setStatusMessage: (message: string) => void;
}

export function useProjectDiagnostics(context: UseProjectDiagnosticsContext) {
  const { rootsRef, openFilesRef, looseFilesRef, workspaceInstanceId, mountedRef, findRoot, inspectionPathForFileKey, bottomDockOpen, bottomDockTab, lspDescriptorForPath, setStatusMessage } = context;
  // M7-C: whole-project Problems. jdtls stores diagnostics for unopened files
  // after a build; we poll the aggregate while the panel is in "project" scope
  // (push events were dropped — see lsp.rs C-1). `key` is the absolute path.
  const [problemsScope, setProblemsScope] = useState<ProblemsScope>("open");
  const [projectProblemFiles, setProjectProblemFiles] = useState<ProblemFileGroup[]>([]);
  const [projectProblemsLoading, setProjectProblemsLoading] = useState(false);
  const [rebuildingProject, setRebuildingProject] = useState(false);

  const problemPathToRef = useCallback((rawPath: string): CodeWorkspaceFileRef | null => {
    if (!rawPath) return null;
    let cleanPath = rawPath.trim();
    if (cleanPath.startsWith("file://")) {
      cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\/\/?/, "/"));
    }
    cleanPath = cleanPath.replace(/\\/g, "/");

    // 1. Direct absolute / canonical match against roots
    for (const root of rootsRef.current) {
      const rel = relativePathWithinRoot(root.path, cleanPath);
      if (rel !== null && rel !== "") {
        return { kind: "root", rootId: root.id, path: rel };
      }
    }

    // 2. Search currently open files by matching path, languagePath, or path suffix
    const openFiles = Object.values(openFilesRef.current);
    const matchingOpen = openFiles.find(
      (f) =>
        f.ref.path === cleanPath ||
        f.path === cleanPath ||
        f.languagePath === cleanPath ||
        f.ref.path.endsWith(`/${cleanPath}`) ||
        f.path.endsWith(`/${cleanPath}`),
    );
    if (matchingOpen) {
      return matchingOpen.ref;
    }

    // 3. If relative path and not starting with '/' or Windows drive 'C:/'
    const isAbsolute = cleanPath.startsWith("/") || /^[a-zA-Z]:\//.test(cleanPath);
    if (!isAbsolute && rootsRef.current.length > 0) {
      // If single root or active root matches, use it
      const targetRoot = rootsRef.current[0];
      if (targetRoot) {
        return { kind: "root", rootId: targetRoot.id, path: cleanPath.replace(/^\/+/, "") };
      }
    }

    // 4. Check loose files
    const looseMatch = looseFilesRef.current.find(
      (lf) => lf.path === cleanPath || lf.path.endsWith(`/${cleanPath}`),
    );
    if (looseMatch) {
      return { kind: "loose", id: looseMatch.id, path: looseMatch.path };
    }

    return null;
  }, []);

  const refreshProjectProblems = useCallback(async () => {
    try {
      const files = await lspWorkspaceDiagnostics(workspaceInstanceId);
      if (!mountedRef.current) return;
      setProjectProblemFiles(files.map((entry): ProblemFileGroup => {
        const ref = problemPathToRef(entry.path);
        const rootName = ref?.kind === "root" ? findRoot(ref.rootId)?.name : undefined;
        const subtitle = ref?.kind === "root"
          ? (rootName ? `${rootName} / ${ref.path}` : ref.path)
          : entry.path;
        return {
          key: entry.path,
          title: basename(entry.path),
          subtitle,
          path: inspectionPathForFileKey(entry.path),
          diagnostics: entry.diagnostics,
        };
      }));
    } catch {
      // No active jdtls session / command unsupported: leave the list as-is.
    }
  }, [findRoot, inspectionPathForFileKey, problemPathToRef, workspaceInstanceId]);

  // A pull-capable server may invalidate workspace diagnostics between polling
  // ticks. Refresh the aggregate immediately when the backend forwards the
  // standard `workspace/diagnostic/refresh` request.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ workspaceId?: unknown }>(LSP_DIAGNOSTICS_REFRESH_EVENT, (event) => {
      if (disposed || event.payload?.workspaceId !== workspaceInstanceId) return;
      void refreshProjectProblems();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshProjectProblems, workspaceInstanceId]);

  // Poll project diagnostics while the Problems panel is open in project scope.
  useEffect(() => {
    if (!(bottomDockOpen
      && (bottomDockTab === "problems" || bottomDockTab === "analysis")
      && problemsScope === "project")) return;
    let cancelled = false;
    setProjectProblemsLoading(true);
    void refreshProjectProblems().finally(() => {
      if (!cancelled && mountedRef.current) setProjectProblemsLoading(false);
    });
    const timer = window.setInterval(() => void refreshProjectProblems(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bottomDockOpen, bottomDockTab, problemsScope, refreshProjectProblems]);

  const rebuildProject = useCallback(async () => {
    const root = rootsRef.current[0];
    if (!root) return;
    // A synthetic .java path selects the root's jdtls session (keyed on scope).
    const descriptor = lspDescriptorForPath(root.path, "__taomni_build__.java");
    setRebuildingProject(true);
    try {
      await lspBuildWorkspace(descriptor);
      setStatusMessage("Rebuilding project…");
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      if (mountedRef.current) setRebuildingProject(false);
    }
    // Give jdtls a beat to publish, then refresh.
    window.setTimeout(() => void refreshProjectProblems(), 1200);
  }, [lspDescriptorForPath, refreshProjectProblems, setStatusMessage]);
  return { problemsScope, projectProblemFiles, problemPathToRef, setProblemsScope, rebuildProject, rebuildingProject, projectProblemsLoading };
}

import { useCallback, useMemo } from "react";
import { type LspDiagnostic, type LspLocation } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { evidencePresentationLine } from "../capabilityEvidence";
import { fileKey, type LspFileState } from "../codeWorkspaceModel";
import { diagnosticInspectionId, replaceInspectionBaseline } from "../inspectionProfile";
import { toProviderDiagnosticsV3 } from "../inspectionProviderAdapter";
import { type ProblemFileGroup } from "../panels/ProblemsPanel";


export interface UseWorkspaceProblemPresentationContext {
  problemsScopeFiles: ProblemFileGroup[];
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  suppressedInSourceKeys: Set<string>;
  inspectionPathForFileKey: (fileKeyValue: string) => string;
  persistInspectionProfile: (update: (current: import("../inspectionProfile").InspectionProfile) => import("../inspectionProfile").InspectionProfile) => void;
  setStatusMessage: (message: string) => void;
  inspectionTransform: (diagnostic: LspDiagnostic, path?: string) => LspDiagnostic | null;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  problemPathToRef: (rawPath: string) => CodeWorkspaceFileRef | null;
  openLspLocation: (location: LspLocation, options?: import("../controller/model").LspLocationOpenOptions) => Promise<boolean>;
}

export function useWorkspaceProblemPresentation(context: UseWorkspaceProblemPresentationContext) {
  const {
    problemsScopeFiles,
    lspFilesRef,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    openFilesRef,
    suppressedInSourceKeys,
    inspectionPathForFileKey,
    persistInspectionProfile,
    setStatusMessage,
    inspectionTransform,
    revealEditorLocation,
    openFile,
    problemPathToRef,
    openLspLocation,
  } = context;
  // §8.20.4 DoD: every diagnostic row shows provider/scope/revision/completeness.
  const problemEvidenceLinesByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of problemsScopeFiles) {
      const state = lspFilesRef.current[file.key];
      if (!state) continue;
      for (const wrapped of toProviderDiagnosticsV3(state.diagnostics ?? [], {
        languageId: state.status?.languageId ?? "plaintext",
        provider: { id: "jdtls", version: state.status?.displayName ?? null, generation: lspSessionGeneration() },
        projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: state.status?.uri ?? file.key,
        revision: openFilesRef.current[file.key]?.documentRevision ?? 0,
      })) {
        map.set(
          `${file.key}:${wrapped.diagnostic.message}:${wrapped.diagnostic.range.start.line}`,
          evidencePresentationLine(wrapped.evidence),
        );
      }
    }
    return map;
  }, [lspSessionGeneration, problemsScopeFiles, projectAnalysisSnapshot?.projectFingerprint]);
  const evidenceLineForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    problemEvidenceLinesByKey.get(`${fileKey}:${diagnostic.message}:${diagnostic.range.start.line}`) ?? null
  ), [problemEvidenceLinesByKey]);
  const suppressedInSourceForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    suppressedInSourceKeys.has(
      `${inspectionPathForFileKey(fileKey)}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`,
    )
  ), [inspectionPathForFileKey, suppressedInSourceKeys]);
  const createInspectionBaselineFromScope = useCallback(() => {
    const sources = problemsScopeFiles.flatMap((file) => file.diagnostics.map((diagnostic) => ({
      diagnostic,
      path: inspectionPathForFileKey(file.key),
    })));
    persistInspectionProfile((current) => replaceInspectionBaseline(current, sources));
    setStatusMessage(`Inspection baseline replaced with ${sources.length} provider diagnostic${sources.length === 1 ? "" : "s"}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, problemsScopeFiles, setStatusMessage]);
  const activeProblemCounts = useMemo(
    () => problemsScopeFiles.reduce(
      (counts, file) => {
        for (const diagnostic of file.diagnostics) {
          const display = inspectionTransform(diagnostic, file.path ?? file.subtitle);
          if (display?.severity === 1) counts.errors += 1;
          else if (display?.severity === 2) counts.warnings += 1;
        }
        return counts;
      },
      { errors: 0, warnings: 0 },
    ),
    [inspectionTransform, problemsScopeFiles],
  );

  const openProblem = useCallback(
    (fileKeyValue: string, diagnostic: LspDiagnostic) => {
      // Open-file key (open scope) → reveal in place.
      const openState = openFilesRef.current[fileKeyValue];
      if (openState) {
        revealEditorLocation(openState.key, diagnostic.range);
        void openFile(openState.ref);
        return;
      }
      // Project scope: the key is an absolute path to a (possibly unopened) file.
      const ref = problemPathToRef(fileKeyValue);
      if (!ref) return;
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), diagnostic.range));
    },
    [openFile, problemPathToRef, revealEditorLocation],
  );

  const openRelatedDiagnostic = useCallback((diagnostic: LspDiagnostic) => {
    const location = diagnostic.relatedInformation?.[0]?.location;
    if (location) void openLspLocation(location);
  }, [openLspLocation]);
  return { activeProblemCounts, openProblem, openRelatedDiagnostic, evidenceLineForProblem, suppressedInSourceForProblem, createInspectionBaselineFromScope };
}

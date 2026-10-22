import { useCallback, useEffect, useMemo, useState } from "react";
import { readText, writeText } from "../../../../lib/clipboard";
import { type LspDiagnostic } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { EMPTY_DISPLAY_DIAGNOSTICS } from "../controller/model";
import {
  addDiagnosticToInspectionBaseline,
  addInspectionSuppression,
  applyInspectionProfile,
  clearInspectionBaseline,
  importInspectionBaseline,
  readInspectionProfile,
  removeInspectionBaselineEntry,
  removeInspectionSuppression,
  serializeInspectionBaseline,
  updateInspectionRule,
  writeInspectionProfile,
  type InspectionProfile,
  type InspectionRule,
  type InspectionSuppressionScope,
} from "../inspectionProfile";


export interface UseWorkspaceInspectionsContext {
  workspaceInstanceId: string;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setStatusMessage: (message: string) => void;
}

export function useWorkspaceInspections(context: UseWorkspaceInspectionsContext) {
  const { rootsRef, workspaceInstanceId, openFilesRef, setStatusMessage } = context;
  const [inspectionProfile, setInspectionProfile] = useState<InspectionProfile>(
    () => readInspectionProfile(workspaceInstanceId),
  );
  useEffect(() => {
    setInspectionProfile(readInspectionProfile(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const persistInspectionProfile = useCallback((
    update: (current: InspectionProfile) => InspectionProfile,
  ) => {
    setInspectionProfile((current) => {
      return writeInspectionProfile(workspaceInstanceId, update(current));
    });
  }, [workspaceInstanceId]);
  const updateInspectionProfileRule = useCallback((id: string, patch: Partial<InspectionRule>) => {
    persistInspectionProfile((current) => updateInspectionRule(current, id, patch));
  }, [persistInspectionProfile]);
  const inspectionPathForFileKey = useCallback((fileKeyValue: string): string => {
    const open = openFilesRef.current[fileKeyValue];
    const ref = open?.ref;
    if (ref?.kind === "root") {
      return `root:${ref.rootId}:${normalizeFsPath(ref.path).replace(/^\/+/, "")}`;
    }
    if (ref) return `loose:${normalizeFsPath(ref.path)}`;
    for (const root of rootsRef.current) {
      const relative = relativePathWithinRoot(root.path, fileKeyValue);
      if (relative !== null) return `root:${root.id}:${normalizeFsPath(relative).replace(/^\/+/, "")}`;
    }
    return normalizeFsPath(fileKeyValue);
  }, []);
  const suppressInspection = useCallback((
    fileKeyValue: string,
    diagnostic: LspDiagnostic,
    scope: InspectionSuppressionScope,
  ) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addInspectionSuppression(current, diagnostic, path, scope));
    setStatusMessage(`Hidden locally (${scope}): ${diagnostic.source ?? "inspection"}:${diagnostic.code ?? "*"}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const addInspectionBaseline = useCallback((fileKeyValue: string, diagnostic: LspDiagnostic) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addDiagnosticToInspectionBaseline(current, diagnostic, path));
    setStatusMessage("Added diagnostic to inspection baseline");
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const clearInspectionBaselineEntries = useCallback(() => {
    persistInspectionProfile(clearInspectionBaseline);
    setStatusMessage("Inspection baseline cleared");
  }, [persistInspectionProfile, setStatusMessage]);
  const removeInspectionBaseline = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionBaselineEntry(current, key));
  }, [persistInspectionProfile]);
  const removeInspectionSuppressionEntry = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionSuppression(current, key));
  }, [persistInspectionProfile]);
  const exportInspectionBaseline = useCallback(async () => {
    const text = serializeInspectionBaseline(inspectionProfile);
    await writeText(text);
    setStatusMessage("Inspection baseline copied to clipboard");
  }, [inspectionProfile, setStatusMessage]);
  const importInspectionBaselineFromClipboard = useCallback(async () => {
    try {
      const text = await readText();
      // Validate before entering the state updater. An invalid clipboard
      // payload must report an import error without throwing during render.
      const imported = importInspectionBaseline(inspectionProfile, text);
      persistInspectionProfile((current) => ({
        ...current,
        baseline: imported.baseline,
      }));
      setStatusMessage("Inspection baseline imported");
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  }, [inspectionProfile, persistInspectionProfile, setStatusMessage]);
  const inspectionTransform = useCallback(
    (diagnostic: LspDiagnostic, path?: string): LspDiagnostic | null => (
      applyInspectionProfile(diagnostic, inspectionProfile, { path })
    ),
    [inspectionProfile],
  );
  // The session layer already content-dedupes `lspFiles[key].diagnostics`, so the
  // source array identity is stable between real diagnostic changes. Mapping it
  // through the inspection profile on every render would throw that stability
  // away and defeat CodeMirrorHost's identity-based memo, forcing a full
  // diagnostics-compartment reconfigure per render. Cache per source array so
  // the mapped result keeps the same identity too.
  const displayDiagnosticsCache = useMemo(
    () => new WeakMap<readonly LspDiagnostic[], { path: string | undefined; result: LspDiagnostic[]; }>(),
    [inspectionProfile],
  );
  const displayDiagnosticsFor = useCallback(
    (source: LspDiagnostic[] | null | undefined, path: string | undefined): LspDiagnostic[] => {
      if (!source || source.length === 0) return EMPTY_DISPLAY_DIAGNOSTICS;
      const cached = displayDiagnosticsCache.get(source);
      if (cached && cached.path === path) return cached.result;
      const mapped = source.flatMap((diagnostic) => {
        const display = inspectionTransform(diagnostic, path);
        return display ? [display] : [];
      });
      const result = mapped.length === 0 ? EMPTY_DISPLAY_DIAGNOSTICS : mapped;
      displayDiagnosticsCache.set(source, { path, result });
      return result;
    },
    [displayDiagnosticsCache, inspectionTransform],
  );
  return { inspectionPathForFileKey, displayDiagnosticsFor, persistInspectionProfile, inspectionTransform, suppressInspection, addInspectionBaseline, inspectionProfile, updateInspectionProfileRule, clearInspectionBaselineEntries, removeInspectionBaseline, removeInspectionSuppressionEntry, exportInspectionBaseline, importInspectionBaselineFromClipboard };
}

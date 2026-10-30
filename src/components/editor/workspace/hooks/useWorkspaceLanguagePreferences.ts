import { useCallback, useEffect } from "react";
import { loadAutoImportPreferences } from "../../../../lib/autoImportPreferences";
import { type OpenFileState } from "../codeWorkspaceModel";
import { inlayHintsEnabledForLanguage } from "../intelligencePreferences";
import { BUILT_IN_SCHEME_ID, activeSchemeForLanguage } from "../workspaceCodeStyleSchemes";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceCodeStyle } from "./useWorkspaceCodeStyle";
import { useWorkspaceDocumentLanguage } from "./useWorkspaceDocumentLanguage";
import { useWorkspaceIntelligencePreferences } from "./useWorkspaceIntelligencePreferences";


export interface UseWorkspaceLanguagePreferencesContext {
  intelligence: ReturnType<typeof useWorkspaceIntelligencePreferences>;
  documentLanguage: ReturnType<typeof useWorkspaceDocumentLanguage>;
  codeStyle: ReturnType<typeof useWorkspaceCodeStyle>;
  setStatusMessage: (message: string) => void;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  executeAutoImportOnTheFly: (targetFile?: OpenFileState) => Promise<import("../autoImportModel").AutoImportPlanOutcome>;
}

export function useWorkspaceLanguagePreferences(context: UseWorkspaceLanguagePreferencesContext) {
  const { intelligence, documentLanguage, codeStyle, setStatusMessage, bufferState, workspaceUi } = context;
  const toggleInlayHints = useCallback(() => {
    intelligence.setIntelligencePreferences((current) => ({
      ...current,
      inlayHintsEnabled: !current.inlayHintsEnabled,
    }));
  }, [intelligence.setIntelligencePreferences]);
  const toggleInlayHintsForActiveLanguage = useCallback(() => {
    const languageId = documentLanguage.activeLanguageId;
    intelligence.setIntelligencePreferences((current) => {
      if (!languageId) return { ...current, inlayHintsEnabled: !current.inlayHintsEnabled };
      const currentlyEnabled = inlayHintsEnabledForLanguage(current, languageId);
      return {
        ...current,
        inlayHintsEnabled: true,
        inlayHintLanguages: {
          ...current.inlayHintLanguages,
          [languageId]: !currentlyEnabled,
        },
      };
    });
  }, [documentLanguage.activeLanguageId, intelligence.setIntelligencePreferences]);
  const toggleInlineBlame = useCallback(() => {
    intelligence.setIntelligencePreferences((current) => ({
      ...current,
      inlineBlameEnabled: !current.inlineBlameEnabled,
    }));
  }, [intelligence.setIntelligencePreferences]);
  const setFormatOnSave = useCallback((enabled: boolean) => {
    codeStyle.setCodeStyleSchemes((current) => {
      const active = activeSchemeForLanguage(current, documentLanguage.activeLanguageId || null);
      if (!active || active.id === BUILT_IN_SCHEME_ID) {
        return current;
      }
      const updatedSchemes = current.schemes.map((scheme) => {
        if (scheme.id === active.id) {
          return {
            ...scheme,
            saveActions: {
              ...scheme.saveActions,
              format: enabled,
            },
          };
        }
        return scheme;
      });
      return { ...current, schemes: updatedSchemes };
    });
    intelligence.setIntelligencePreferences((current) => ({
      ...current,
      formatOnSave: enabled,
    }));
    setStatusMessage(`Format on save ${enabled ? "enabled" : "disabled"} for this workspace`);
  }, [documentLanguage.activeLanguageId, codeStyle.setCodeStyleSchemes, intelligence.setIntelligencePreferences, setStatusMessage]);

  // ED-IMPORT-001: Automatic on-the-fly auto-import trigger on diagnostics change
  useEffect(() => {
    const activeFile = documentLanguage.activeFile;
    if (!activeFile) return;
    const isJava = activeFile.languagePath.endsWith(".java") || bufferState.lspFilesRef.current[activeFile.key]?.status?.languageId === "java";
    if (!isJava) return;
    const settings = loadAutoImportPreferences();
    if (!settings.addUnambiguousImportsOnTheFly) return;
    const diags = workspaceUi.lspFiles[activeFile.key]?.diagnostics ?? [];
    const hasUnresolved = diags.some((d) =>
      /cannot find symbol|cannot be resolved to a type|unknown class|cannot resolve symbol/i.test(d.message)
    );
    if (!hasUnresolved) return;
    const timer = setTimeout(() => {
      void context.executeAutoImportOnTheFly(activeFile);
    }, 250);
    return () => clearTimeout(timer);
  }, [documentLanguage.activeFile, context.executeAutoImportOnTheFly, workspaceUi.lspFiles]);
  return { setFormatOnSave, toggleInlayHints, toggleInlayHintsForActiveLanguage, toggleInlineBlame };
}

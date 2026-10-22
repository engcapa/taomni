import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceReadFile, workspaceReadLooseFile } from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { resolveEffectiveCodeStyle, type EffectiveCodeStyle, type ExplicitIndentationOverride } from "../codeStyleModel";
import { normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import type { ResolvedCodeStyle } from "../editorConfigResolver";
import { activeSchemeForLanguage, readCodeStyleSchemeStore, schemeStyleFields, writeCodeStyleSchemeStore, type CodeStyleSchemeStoreState } from "../workspaceCodeStyleSchemes";
import { createWorkspaceStyleController, type WorkspaceStyleController } from "../workspaceStyleController";


export interface UseWorkspaceCodeStyleContext {
  workspaceInstanceId: string;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  roots: CodeWorkspaceRootInfo[];
}

export function useWorkspaceCodeStyle(context: UseWorkspaceCodeStyleContext) {
  const { workspaceInstanceId, rootsRef, roots } = context;
  // §8.19.9 R8-D1: code style schemes — production store with persistence;
  // the active scheme layers into effective-style resolution BELOW EditorConfig.
  const [codeStyleSchemes, setCodeStyleSchemes] = useState<CodeStyleSchemeStoreState>(
    () => readCodeStyleSchemeStore(),
  );
  const codeStyleSchemesRef = useRef(codeStyleSchemes);
  codeStyleSchemesRef.current = codeStyleSchemes;
  const changeCodeStyleSchemes = useCallback((next: CodeStyleSchemeStoreState) => {
    setCodeStyleSchemes(next);
    writeCodeStyleSchemeStore(next);
  }, []);
  const [codeStyleSettingsOpen, setCodeStyleSettingsOpen] = useState(false);

  const [indentationOverrides, setIndentationOverrides] = useState<Record<string, ExplicitIndentationOverride | null>>({});
  const indentationOverridesRef = useRef(indentationOverrides);
  indentationOverridesRef.current = indentationOverrides;

  const resolvedCodeStylesRef = useRef<Record<string, ResolvedCodeStyle>>({});
  const workspaceStyleControllerRef = useRef<WorkspaceStyleController>(
    createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: {
        readFile: async () => null,
      },
    }),
  );

  const rootsFingerprint = roots.map((r) => `${r.id}:${r.path}`).join("|");

  useEffect(() => {
    const provider = {
      readFile: async (absolutePath: string) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, normalized);
          if (rel !== null) {
            try {
              const res = await workspaceReadFile(root.path, rel);
              return res.text;
            } catch {
              return null;
            }
          }
        }
        try {
          const res = await workspaceReadLooseFile(normalized);
          return res.text;
        } catch {
          return null;
        }
      },
    };
    workspaceStyleControllerRef.current = createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: provider,
    });

    return () => {
      workspaceStyleControllerRef.current.clearCache();
    };
  }, [rootsFingerprint, workspaceInstanceId]);

  const getEffectiveCodeStyleForFile = useCallback((file: { key: string; languagePath: string; text: string; } | null): EffectiveCodeStyle | undefined => {
    if (!file) return undefined;
    const asyncResolved = resolvedCodeStylesRef.current[file.key];
    if (asyncResolved) return asyncResolved;
    const explicitOverride = indentationOverridesRef.current[file.key];
    // §8.19.9 R8-D1: the active scheme for the file's extension-keyed
    // language participates below EditorConfig.
    const languageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const activeScheme = activeSchemeForLanguage(codeStyleSchemesRef.current, languageKey || null);
    return resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride,
      activeSchemeFields: schemeStyleFields(activeScheme),
    });
  }, []);
  return {
    workspaceStyleControllerRef,
    indentationOverridesRef,
    codeStyleSchemesRef,
    resolvedCodeStylesRef,
    setCodeStyleSchemes,
    getEffectiveCodeStyleForFile,
    setIndentationOverrides,
    setCodeStyleSettingsOpen,
    codeStyleSettingsOpen,
    codeStyleSchemes,
    changeCodeStyleSchemes,
  };
}

import { useRef, useLayoutEffect } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { liveTemplateLanguageForPath } from "../liveTemplates";
import { editorAppearanceExtension } from "../editorAppearanceExtension";
import { renderedDocDecorationConfig } from "../renderedDocCommentsExtension";
import { sameEditorAppearance } from "./reconciliation";
import { readOnlyExtension } from "./appearance";


export interface UseEditorPresentationContext {
  viewRef: import("react").RefObject<EditorView | null>;
  readOnly: boolean;
  appearance: import("../editorAppearanceExtension").EditorAppearanceExtensionProfile | undefined;
  softWrap: boolean;
  renderedDocLanguageId: string | null | undefined;
  path: string;
  renderedDocEnabled: boolean;
  onToggleRenderedDocRawRef: import("react").RefObject<(() => void) | undefined>;
}

export function useEditorPresentation(context: UseEditorPresentationContext) {
  const { viewRef, readOnly, appearance, softWrap, renderedDocLanguageId, path, renderedDocEnabled, onToggleRenderedDocRawRef } = context;

  const readOnlyCompartment = useRef(new Compartment());
  const wrappingCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
  const renderedDocCompartment = useRef(new Compartment());
  const renderedReadOnlyRef = useRef(readOnly);
  const renderedSoftWrapRef = useRef(softWrap);
  const renderedAppearanceRef = useRef(appearance);
  const renderedDocConfigRef = useRef({
    enabled: !!renderedDocEnabled,
    languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(path),
  });


  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedReadOnlyRef.current === readOnly) return;
    renderedReadOnlyRef.current = readOnly;
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameEditorAppearance(renderedAppearanceRef.current, appearance)) return;
    renderedAppearanceRef.current = appearance;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        appearance ? editorAppearanceExtension(appearance) : [],
      ),
    });
  }, [appearance]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedSoftWrapRef.current === softWrap) return;
    renderedSoftWrapRef.current = softWrap;
    view.dispatch({
      effects: wrappingCompartment.current.reconfigure(softWrap ? EditorView.lineWrapping : []),
    });
  }, [softWrap]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const languageId = renderedDocLanguageId ?? liveTemplateLanguageForPath(path);
    const enabled = !!renderedDocEnabled;
    const previous = renderedDocConfigRef.current;
    if (previous.enabled === enabled && previous.languageId === languageId) return;
    renderedDocConfigRef.current = { enabled, languageId };
    view.dispatch({
      effects: renderedDocCompartment.current.reconfigure(
        renderedDocDecorationConfig.of({
          languageId,
          enabled,
          onToggleRaw: () => {
            onToggleRenderedDocRawRef.current?.();
            viewRef.current?.focus();
          },
        }),
      ),
    });
  }, [path, renderedDocEnabled, renderedDocLanguageId]);
  return { readOnlyCompartment, wrappingCompartment, appearanceCompartment, renderedDocCompartment, renderedReadOnlyRef, renderedSoftWrapRef, renderedAppearanceRef, renderedDocConfigRef };
}

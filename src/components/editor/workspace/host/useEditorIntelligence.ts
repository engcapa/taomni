import { useRef, useEffect, useLayoutEffect } from "react";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { type WindowResizeSession } from "../windowResizeSession";
import { languageForPath } from "../../../git/diffLanguage";
import { lspHoverExtension, cancelActiveHoverResize, signatureTooltipDom } from "./intelligence";


export interface UseEditorIntelligenceContext {
  fileKey: string;
  path: string;
  viewRef: import("react").RefObject<EditorView | null>;
  showHoverDocumentation: boolean;
  hoverDocumentationDelayMs: number;
  onHoverRef: import("react").RefObject<(position: import("../../../../lib/editor/lsp").LspPosition) => Promise<import("../referenceDocumentation").QuickDocContent | null>>;
  onPinHoverDocRef: import("react").RefObject<((content: import("../referenceDocumentation").QuickDocContent) => void) | undefined>;
  parameterInfoRequestNonce: number;
  parameterPopup: import("../referenceInfoSession").ParameterPopupView | null;
  parameterInfoShowFullSignaturesRef: import("react").RefObject<boolean>;
}

export function useEditorIntelligence(context: UseEditorIntelligenceContext) {
  const {
    path,
    viewRef,
    showHoverDocumentation,
    hoverDocumentationDelayMs,
    onHoverRef,
    onPinHoverDocRef,
    parameterInfoRequestNonce,
    parameterPopup,
    parameterInfoShowFullSignaturesRef,
  } = context;

  const languageCompartment = useRef(new Compartment());
  const signatureCompartment = useRef(new Compartment());
  const hoverCompartment = useRef(new Compartment());
  const lastParameterInfoNonceRef = useRef(parameterInfoRequestNonce);
  const requestParameterInfoRef = useRef<(() => boolean) | null>(null);
  const activeHoverResizeSessionRef = useRef<WindowResizeSession | null>(null);
  const renderedHoverRef = useRef({
    enabled: showHoverDocumentation,
    delayMs: hoverDocumentationDelayMs,
  });

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, context.fileKey]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedHoverRef.current;
    if (
      previous.enabled === showHoverDocumentation
      && previous.delayMs === hoverDocumentationDelayMs
    ) {
      return;
    }
    renderedHoverRef.current = {
      enabled: showHoverDocumentation,
      delayMs: hoverDocumentationDelayMs,
    };
    cancelActiveHoverResize(activeHoverResizeSessionRef);
    view.dispatch({
      effects: hoverCompartment.current.reconfigure(lspHoverExtension(
        onHoverRef,
        onPinHoverDocRef,
        activeHoverResizeSessionRef,
        showHoverDocumentation,
        hoverDocumentationDelayMs,
      )),
    });
  }, [hoverDocumentationDelayMs, showHoverDocumentation]);

  useEffect(() => {
    if (parameterInfoRequestNonce === lastParameterInfoNonceRef.current) return;
    lastParameterInfoNonceRef.current = parameterInfoRequestNonce;
    requestParameterInfoRef.current?.();
  }, [parameterInfoRequestNonce]);

  // §8.20.2 W1: the Parameter Info tooltip is pure display — it renders the
  // session-published view and nothing else. No request sequence lives here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    if (!parameterPopup || parameterPopup.signatures.length === 0) {
      window.queueMicrotask(() => {
        const current = viewRef.current;
        if (cancelled || !current || current !== view) return;
        current.dispatch({ effects: signatureCompartment.current.reconfigure([]) });
      });
      return () => { cancelled = true; };
    }
    const pos = Math.min(Math.max(0, parameterPopup.anchorOffset), view.state.doc.length);
    view.dispatch({
      effects: signatureCompartment.current.reconfigure(
        showTooltip.of({
          pos,
          above: true,
          create: () => ({
            dom: signatureTooltipDom(parameterPopup, parameterInfoShowFullSignaturesRef.current),
          }),
        }),
      ),
    });
  }, [parameterPopup, context.fileKey]);
  return { languageCompartment, signatureCompartment, hoverCompartment, lastParameterInfoNonceRef, requestParameterInfoRef, activeHoverResizeSessionRef, renderedHoverRef };
}

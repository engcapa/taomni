import { useCallback, useMemo, useRef } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { autocompletion, completionStatus, currentCompletions, selectedCompletion, setSelectedCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import {
  createLiveTemplateCompletionSource,
  isProviderTemplateSnippet,
  liveTemplateLanguageForPath,
  matchLiveTemplateAbbreviation,
  plainTemplateAbbreviations,
  type LiveTemplateLanguage,
  type LiveTemplateSourceOptions,
} from "../liveTemplates";
import { createLspCompletionSource, type CompletionRequestIdentity, type CompletionResolveGateRequest } from "../lspCompletion";
import { positionCompletionInfo } from "./appearance";
const COMPLETION_INTERACTION_DELAY_MS = 75;


export interface UseProviderCompletionContext {
  getCompletionIdentityRef: import("react").RefObject<() => CompletionRequestIdentity | null>;
  viewRef: import("react").RefObject<EditorView | null>;
  completionController: import("../lspCompletion").LspCompletionController | undefined;
  hoverDocumentationDelayMs: number;
  pathRef: import("react").RefObject<string>;
  completionCompartment: import("react").RefObject<Compartment>;
  onCompleteRef: import("react").RefObject<((position: import("../../../../lib/editor/lsp").LspPosition, triggerCharacter: string | null, token: import("../lspCompletion").CompletionRequestToken, invocation?: import("../lspCompletion").CompletionInvocationRequest) => Promise<import("../../../../lib/editor/lsp").LspCompletionResult | null>) | undefined>;
  onCompleteResolveRef: import("react").RefObject<((raw: unknown, token: import("../lspCompletion").CompletionRequestToken) => Promise<import("../../../../lib/editor/lsp").LspCompletionResolveResult | import("../../../../lib/editor/lsp").LspCompletionItem | null>) | undefined>;
  completionTriggersRef: import("react").RefObject<string[]>;
  onCompletionDiagnosticRef: import("react").RefObject<(kind: import("../lspCompletion").CompletionAcceptanceDiagnostic, detail?: string) => void>;
  onScopeFallbackRef: import("react").RefObject<((state: import("../completionScopeAdapter").CompletionScopeFactsState) => void) | undefined>;
  onCompletionUnavailableRef: import("react").RefObject<((info: { explicit: boolean; }) => void) | undefined>;
  presentResolveGateRef: import("react").RefObject<((request: CompletionResolveGateRequest) => void) | null>;
  pendingCompletionAcceptanceRef: import("react").RefObject<(() => void) | null>;
  resolveGateSequenceRef: import("react").RefObject<number>;
  setResolveGateUi: import("react").Dispatch<import("react").SetStateAction<{ id: number; label: string; message: string; failed: boolean; retrying: boolean; top: number; left: number; retry: () => Promise<"committed" | "unavailable">; insertWithoutImport: () => boolean; dismiss: () => void; } | null>>;
  completionControllerRef: import("react").RefObject<import("../lspCompletion").LspCompletionController | undefined>;
  renderedCompletionPolicyRef: ReturnType<typeof import("./useEditorHostRefs").useEditorHostRefs>["renderedCompletionPolicyRef"];
}

export function useProviderCompletion(hostContext: UseProviderCompletionContext) {
  const {
    getCompletionIdentityRef,
    viewRef,
    completionController,
    hoverDocumentationDelayMs,
    pathRef,
    completionCompartment,
    onCompleteRef,
    onCompleteResolveRef,
    completionTriggersRef,
    onCompletionDiagnosticRef,
    onScopeFallbackRef,
    onCompletionUnavailableRef,
    presentResolveGateRef,
    pendingCompletionAcceptanceRef,
    resolveGateSequenceRef,
    setResolveGateUi,
    completionControllerRef,
  } = hostContext;

  interface ActiveProviderTemplateState {
    workspaceId: string;
    fileKey: string;
    documentRevision: number;
    lspSessionGeneration: number;
    from: number;
    to: number;
    items: Map<string, Completion>;
  }

  /**
   * Plain abbreviations the language provider currently offers: jdtls ships the Eclipse
   * Java editor templates as snippet proposals, and those exact IDs win over
   * the app's live templates when valid for the current revision and caret range.
   * Merged per active result, not permanently suppressed across the whole session.
   */
  const currentProviderTemplatesRef = useRef<ActiveProviderTemplateState | null>(null);
  const pendingTriggerOriginRef = useRef<{ pos: number; char: string; docLength: number; } | null>(null);

  const completionPolicyGenerationRef = useRef(0);
  const localRefreshTimerRef = useRef<number | null>(null);
  const lastCollisionFingerprintRef = useRef<string>("");
  const activeQueryCounterRef = useRef(0);
  const lastAppliedQueryIdRef = useRef(0);
  const trackedLspSourceRef = useRef<CompletionSource | null>(null);

  const providerOwnedAbbreviations = useCallback(
    (language: LiveTemplateLanguage): ReadonlySet<string> | undefined => {
      if (language !== "java") return undefined;
      const current = currentProviderTemplatesRef.current;
      if (!current) return undefined;
      const identity = getCompletionIdentityRef.current?.();
      if (!identity) return undefined;
      if (
        current.workspaceId !== identity.workspaceId
        || current.fileKey !== identity.fileKey
        || current.documentRevision !== identity.documentRevision
        || current.lspSessionGeneration !== identity.lspSessionGeneration
      ) {
        return undefined;
      }
      const view = viewRef.current;
      if (view) {
        const pos = view.state.selection.main.head;
        if (pos < current.from || pos > current.to) {
          return undefined;
        }
      }
      return new Set(current.items.keys());
    },
    [],
  );

  const liveTemplateSourceOptions = useMemo<LiveTemplateSourceOptions>(
    () => ({ providerOwnedAbbreviations }),
    [providerOwnedAbbreviations],
  );

  const getValidActiveProviderCandidate = useCallback(
    (
      view: EditorView,
      language: LiveTemplateLanguage,
    ): { completion: Completion; from: number; to: number; } | null => {
      if (language !== "java") return null;
      const current = currentProviderTemplatesRef.current;
      if (!current) return null;
      const identity = getCompletionIdentityRef.current?.();
      if (!identity) return null;
      if (
        current.workspaceId !== identity.workspaceId
        || current.fileKey !== identity.fileKey
        || current.documentRevision !== identity.documentRevision
        || current.lspSessionGeneration !== identity.lspSessionGeneration
      ) {
        return null;
      }
      const pos = view.state.selection.main.head;
      if (!view.state.selection.main.empty) return null;
      const plain = matchLiveTemplateAbbreviation(view.state.doc, pos, language);
      if (!plain?.exact) return null;
      if (plain.from !== current.from || plain.to !== current.to) return null;
      const candidate = current.items.get(plain.template.abbreviation);
      if (!candidate) return null;
      return { completion: candidate, from: plain.from, to: plain.to };
    },
    [],
  );

  const buildAutocompletionConfig = useCallback(
    (localSource: CompletionSource, lspSource: CompletionSource) => {
      const policy = completionController?.getPolicy();
      const autoPopup = policy?.autoPopup ?? true;
      const delayMs = policy?.delayMs ?? 100;
      const maxVisibleItems = policy?.maxVisibleItems ?? 100;
      // This is the configuration installed with the new document. Publishing
      // it avoids immediately rebuilding the same plugins after mounting.
      hostContext.renderedCompletionPolicyRef.current = {
        autoPopup, delayMs, maxVisibleItems,
        docDelayMs: policy?.documentation?.delayMs ?? hoverDocumentationDelayMs ?? 75,
      };

      return autocompletion({
        activateOnTyping: autoPopup,
        activateOnTypingDelay: delayMs,
        defaultKeymap: true,
        icons: true,
        maxRenderedOptions: maxVisibleItems,
        interactionDelay: COMPLETION_INTERACTION_DELAY_MS,
        positionInfo: positionCompletionInfo,
        optionClass: (completion) => [
          completion.type ? `cm-completion-type-${completion.type}` : "",
          (completion as Completion & { isLspProvider?: boolean; }).isLspProvider ? "cm-lsp-provider-option" : "",
        ].filter(Boolean).join(" "),
        override: [localSource, lspSource],
      });
    },
    [completionController, hoverDocumentationDelayMs],
  );

  const scheduleLocalRefresh = useCallback(
    (scope: CompletionRequestIdentity, policyGen: number) => {
      if (localRefreshTimerRef.current !== null) {
        window.clearTimeout(localRefreshTimerRef.current);
        localRefreshTimerRef.current = null;
      }
      localRefreshTimerRef.current = window.setTimeout(() => {
        localRefreshTimerRef.current = null;
        const view = viewRef.current;
        if (!view) return;
        if (completionStatus(view.state) === null) return;
        if (completionPolicyGenerationRef.current !== policyGen) return;
        const identity = getCompletionIdentityRef.current?.();
        if (
          !identity
          || identity.workspaceId !== scope.workspaceId
          || identity.fileKey !== scope.fileKey
          || identity.documentRevision !== scope.documentRevision
          || identity.lspSessionGeneration !== scope.lspSessionGeneration
        ) {
          return;
        }
        const trackedSource = trackedLspSourceRef.current;
        if (!trackedSource) return;

        const newLocalSource = createLiveTemplateCompletionSource(
          () => pathRef.current,
          liveTemplateSourceOptions,
        );
        // A late provider result replaces the local version of a Java template.
        // CodeMirror preserves selection by object identity, so transfer the
        // user's selection to that provider object before removing the local
        // source. This also survives the brief disabled state during refresh.
        const selected = selectedCompletion(view.state);
        const replacement = selected?.section === "Live Templates"
          ? currentProviderTemplatesRef.current?.items.get(selected.label)
          : undefined;
        const replacementIndex = replacement ? currentCompletions(view.state).indexOf(replacement) : -1;
        if (replacementIndex >= 0) {
          view.dispatch({ effects: setSelectedCompletion(replacementIndex) });
        }
        view.dispatch({
          effects: completionCompartment.current.reconfigure(
            buildAutocompletionConfig(newLocalSource, trackedSource),
          ),
        });
      }, 0);
    },
    [buildAutocompletionConfig, liveTemplateSourceOptions],
  );

  const handleProviderTemplateClaim = useCallback(
    (
      result: CompletionResult | null,
      contextPos: number,
      capturedIdentity: CompletionRequestIdentity,
      capturedPolicyGen: number,
    ): void => {
      const language = liveTemplateLanguageForPath(pathRef.current);
      if (language !== "java") {
        currentProviderTemplatesRef.current = null;
        return;
      }

      if (!result || result.options.length === 0) {
        currentProviderTemplatesRef.current = null;
        const from = result?.from ?? 0;
        const emptyFingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${from}:${contextPos}:`;
        if (lastCollisionFingerprintRef.current !== "" && lastCollisionFingerprintRef.current !== emptyFingerprint) {
          lastCollisionFingerprintRef.current = emptyFingerprint;
          scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
        }
        return;
      }

      const snippets = new Map<string, Completion>();
      for (const option of result.options) {
        if (isProviderTemplateSnippet(option) && option.label) {
          snippets.set(option.label, option);
        }
      }

      if (snippets.size === 0) {
        currentProviderTemplatesRef.current = null;
        const emptyFingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${result.from}:${contextPos}:`;
        if (lastCollisionFingerprintRef.current !== "" && lastCollisionFingerprintRef.current !== emptyFingerprint) {
          lastCollisionFingerprintRef.current = emptyFingerprint;
          scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
        }
        return;
      }

      currentProviderTemplatesRef.current = {
        workspaceId: capturedIdentity.workspaceId,
        fileKey: capturedIdentity.fileKey,
        documentRevision: capturedIdentity.documentRevision,
        lspSessionGeneration: capturedIdentity.lspSessionGeneration,
        from: result.from,
        to: contextPos,
        items: snippets,
      };

      const appAbbreviations = plainTemplateAbbreviations("java");
      const collidingLabels = [...snippets.keys()]
        .filter((label) => appAbbreviations.has(label))
        .sort();

      const fingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${result.from}:${contextPos}:${collidingLabels.join(",")}`;

      if (fingerprint === lastCollisionFingerprintRef.current) {
        return;
      }

      const hadPreviousCollisions = lastCollisionFingerprintRef.current !== "" && !lastCollisionFingerprintRef.current.endsWith(":");
      lastCollisionFingerprintRef.current = fingerprint;

      if (collidingLabels.length === 0 && !hadPreviousCollisions) {
        return;
      }

      scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
    },
    [scheduleLocalRefresh],
  );

  const getOrCreateTrackedLspSource = useCallback(() => {
    if (trackedLspSourceRef.current) {
      return trackedLspSourceRef.current;
    }
    const lspSource = createLspCompletionSource({
      identity: () => getCompletionIdentityRef.current(),
      fetch: (position, trigger, token, invocation) =>
        onCompleteRef.current?.(position, trigger, token, invocation) ?? Promise.resolve(null),
      resolve: (raw, token) =>
        onCompleteResolveRef.current?.(raw, token) ?? Promise.resolve(null),
      triggerCharacters: () => completionTriggersRef.current,
      getDocumentRevision: () => getCompletionIdentityRef.current()?.documentRevision ?? -1,
      reportDiagnostic: (kind, detail) => onCompletionDiagnosticRef.current(kind, detail),
      onScopeFallback: (state) => onScopeFallbackRef.current?.(state),
      onProviderUnavailable: (info) => onCompletionUnavailableRef.current?.(info),
      onResolveGate: (request) => presentResolveGateRef.current?.(request),
      onAcceptancePending: (cancel) => {
        pendingCompletionAcceptanceRef.current?.();
        pendingCompletionAcceptanceRef.current = cancel;
        resolveGateSequenceRef.current += 1;
        setResolveGateUi(null);
      },
      onAcceptanceSettled: (cancel) => {
        if (pendingCompletionAcceptanceRef.current === cancel) {
          pendingCompletionAcceptanceRef.current = null;
        }
      },
      controller: completionControllerRef.current,
      getView: () => viewRef.current,
      consumeTriggerOrigin: (pos, docLength) => {
        const pending = pendingTriggerOriginRef.current;
        if (!pending) return null;
        pendingTriggerOriginRef.current = null;
        if (pending.pos === pos && pending.docLength === docLength) {
          return pending.char;
        }
        return null;
      },
    });

    const trackedLspSource: CompletionSource = async (context: CompletionContext) => {
      const queryId = ++activeQueryCounterRef.current;
      const queryPos = context.pos;
      const capturedIdentity = getCompletionIdentityRef.current?.();
      const capturedPolicyGen = completionPolicyGenerationRef.current;

      const result = await lspSource(context);

      if (context.aborted) {
        return result;
      }
      const view = viewRef.current;
      if (!view) {
        return result;
      }
      if (completionPolicyGenerationRef.current !== capturedPolicyGen) {
        return result;
      }
      if (queryId < lastAppliedQueryIdRef.current) {
        return result;
      }
      lastAppliedQueryIdRef.current = queryId;

      const currentIdentity = getCompletionIdentityRef.current?.();
      if (
        !capturedIdentity
        || !currentIdentity
        || capturedIdentity.workspaceId !== currentIdentity.workspaceId
        || capturedIdentity.fileKey !== currentIdentity.fileKey
        || capturedIdentity.documentRevision !== currentIdentity.documentRevision
        || capturedIdentity.lspSessionGeneration !== currentIdentity.lspSessionGeneration
      ) {
        return result;
      }

      handleProviderTemplateClaim(result, queryPos, capturedIdentity, capturedPolicyGen);
      return result;
    };

    trackedLspSourceRef.current = trackedLspSource;
    return trackedLspSource;
  }, [handleProviderTemplateClaim]);

  const buildAutocompletionExtension = useCallback(() => {
    const trackedSource = getOrCreateTrackedLspSource();
    const localSource = createLiveTemplateCompletionSource(
      () => pathRef.current,
      liveTemplateSourceOptions,
    );
    return buildAutocompletionConfig(localSource, trackedSource);
  }, [buildAutocompletionConfig, getOrCreateTrackedLspSource, liveTemplateSourceOptions]);
  return { buildAutocompletionExtension, pendingTriggerOriginRef, localRefreshTimerRef, getValidActiveProviderCandidate, liveTemplateSourceOptions, completionPolicyGenerationRef, lastCollisionFingerprintRef };
}

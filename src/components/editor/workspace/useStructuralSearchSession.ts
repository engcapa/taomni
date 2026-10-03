import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  nextStructuralRequestId,
  structuralSearchCancel,
  structuralSearchCapabilities,
  structuralSearchRun,
  structuralTemplateVariables,
  type StructuralMatch,
  type StructuralSearchBuffer,
  type StructuralSearchCapabilities,
  type StructuralSearchResponse,
  type StructuralSearchRoot,
} from "../../../lib/editor/structuralSearch";
import {
  structuralSearchAvailability,
  validateStructuralQuery,
  type StructuralQuery,
} from "./companionCapabilities";

export type StructuralScope = StructuralQuery["scope"];

export interface StructuralVariableDraft {
  text: string;
  invert: boolean;
}

export interface StructuralSearchDraft {
  pattern: string;
  scope: StructuralScope;
  matchCase: boolean;
  variables: Record<string, StructuralVariableDraft>;
}

/**
 * idle → running → (results | empty) closes the dialog and shows the result
 * tool window; invalid/unsupported templates stay in the dialog as `error`;
 * `unavailable` never becomes an empty result (ED-PARITY-009-A1).
 */
export type StructuralSearchPhase = "idle" | "running" | "results" | "empty" | "error" | "unavailable" | "cancelled";

export interface StructuralSearchResultState {
  query: StructuralQuery;
  matches: StructuralMatch[];
  truncated: boolean;
  backendLabel: string;
  filesScanned: number;
  elapsedMs: number;
}

interface Options {
  roots: readonly StructuralSearchRoot[];
  activeFile: { rootId: string; path: string } | null;
  getBuffers?: () => StructuralSearchBuffer[];
  onShowResults: () => void;
  onStatus: (message: string) => void;
}

export const DEFAULT_STRUCTURAL_TEMPLATE = "System.out.println($arg$);";

function capabilitiesUnavailableMessage(caps: StructuralSearchCapabilities | null): string {
  if (!caps) return "Structural Search backend is not available in this runtime";
  return `Structural Search backend ${caps.backend.id} is not ready`;
}

export function useStructuralSearchSession({ roots, activeFile, getBuffers, onShowResults, onStatus }: Options) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<StructuralSearchDraft>({
    pattern: DEFAULT_STRUCTURAL_TEMPLATE,
    scope: "workspace",
    matchCase: false,
    variables: {},
  });
  const [phase, setPhase] = useState<StructuralSearchPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<StructuralSearchResultState | null>(null);
  const [capabilities, setCapabilities] = useState<StructuralSearchCapabilities | null>(null);
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const generationRef = useRef(0);
  const activeRequestRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Re-arm on every mount: StrictMode runs mount → cleanup → mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Closing the workspace releases the backend request as well.
      const pending = activeRequestRef.current;
      activeRequestRef.current = null;
      generationRef.current += 1;
      if (pending) void structuralSearchCancel(pending).catch(() => undefined);
    };
  }, []);

  const refreshCapabilities = useCallback(async () => {
    try {
      const next = await structuralSearchCapabilities();
      if (!mountedRef.current) return null;
      const valid = next && typeof next === "object" && typeof next.available === "boolean" ? next : null;
      setCapabilities(valid);
      return valid;
    } catch {
      if (mountedRef.current) setCapabilities(null);
      return null;
    } finally {
      if (mountedRef.current) setCapabilitiesLoaded(true);
    }
  }, []);

  const templateVariables = useMemo(() => structuralTemplateVariables(draft.pattern), [draft.pattern]);
  const availability = structuralSearchAvailability("java", !!capabilities?.available);

  const open = useCallback(() => {
    setDialogOpen(true);
    if (phase === "error" || phase === "cancelled") {
      setPhase("idle");
      setMessage(null);
    }
    void refreshCapabilities();
  }, [phase, refreshCapabilities]);

  const cancel = useCallback(() => {
    const pending = activeRequestRef.current;
    activeRequestRef.current = null;
    // Any response still in flight belongs to a dead generation and is dropped.
    generationRef.current += 1;
    setDialogOpen(false);
    if (pending) {
      setPhase("cancelled");
      setMessage("Structural search cancelled");
      onStatus("Structural search cancelled");
      // The backend releases the request when its worker observes the flag,
      // shortly after cancel returns; poll briefly so activeRequests settles.
      void structuralSearchCancel(pending)
        .catch(() => false)
        .then(async () => {
          for (let attempt = 0; attempt < 40 && mountedRef.current; attempt += 1) {
            const caps = await refreshCapabilities();
            if (!caps || caps.activeRequests === 0) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        });
    } else if (phase === "error") {
      setPhase("idle");
      setMessage(null);
    }
  }, [onStatus, phase, refreshCapabilities]);

  const buildQuery = useCallback((): StructuralQuery => ({
    schemaVersion: 1,
    languageId: "java",
    pattern: draft.pattern,
    scope: draft.scope,
    matchCase: draft.matchCase,
    variables: Object.fromEntries(templateVariables.map((name) => {
      const variable = draft.variables[name];
      return [name, {
        minCount: 1,
        maxCount: 1,
        ...(variable?.text ? { text: variable.text } : {}),
        invert: !!variable?.invert,
      }];
    })),
  }), [draft, templateVariables]);

  const find = useCallback(async () => {
    const query = buildQuery();
    const invalid = validateStructuralQuery(query);
    if (invalid) {
      setPhase("error");
      setMessage(invalid);
      return;
    }
    const caps = capabilitiesLoaded ? capabilities : await refreshCapabilities();
    if (!caps?.available) {
      setPhase("unavailable");
      setMessage(capabilitiesUnavailableMessage(caps));
      return;
    }
    const generation = ++generationRef.current;
    const requestId = nextStructuralRequestId();
    activeRequestRef.current = requestId;
    setPhase("running");
    setMessage(null);
    let response: StructuralSearchResponse | undefined;
    try {
      response = await structuralSearchRun({ requestId, query, roots: [...roots], activeFile, buffers: getBuffers?.() ?? [] });
    } catch (error) {
      if (generationRef.current !== generation || !mountedRef.current) return;
      activeRequestRef.current = null;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
      void refreshCapabilities();
      return;
    }
    if (generationRef.current !== generation || !mountedRef.current) return;
    activeRequestRef.current = null;
    void refreshCapabilities();
    if (!response || typeof response !== "object" || !("status" in response)) {
      setPhase("unavailable");
      setMessage("Structural Search backend returned no typed response");
      return;
    }
    switch (response.status) {
      case "ok": {
        const next: StructuralSearchResultState = {
          query,
          matches: response.matches,
          truncated: response.truncated,
          backendLabel: `${response.backend.id} · ${response.backend.grammar}`,
          filesScanned: response.stats.filesScanned,
          elapsedMs: response.stats.elapsedMs,
        };
        setResult(next);
        setPhase(response.matches.length > 0 ? "results" : "empty");
        setDialogOpen(false);
        onShowResults();
        onStatus(response.matches.length > 0
          ? `Structural search: ${response.matches.length} result${response.matches.length === 1 ? "" : "s"}`
          : "Structural search: no occurrences found");
        return;
      }
      case "unavailable":
        setPhase("unavailable");
        setMessage(response.message);
        return;
      case "error":
        setPhase("error");
        setMessage(response.message);
        return;
      case "cancelled":
        setPhase("cancelled");
        setMessage("Structural search cancelled");
        return;
    }
  }, [activeFile, buildQuery, capabilities, capabilitiesLoaded, getBuffers, onShowResults, onStatus, refreshCapabilities, roots]);

  return {
    dialogOpen,
    draft,
    setDraft,
    phase,
    message,
    result,
    capabilities,
    capabilitiesLoaded,
    availability,
    templateVariables,
    open,
    cancel,
    find,
    refreshCapabilities,
    activeFileAvailable: !!activeFile,
  };
}

export type StructuralSearchSession = ReturnType<typeof useStructuralSearchSession>;

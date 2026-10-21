import { useCallback, useEffect, useRef, useState } from "react";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { type OpenFileState } from "../codeWorkspaceModel";
import { type ReferencesResultState } from "../panels/ReferencesPanel";
import { DEFAULT_SCOPE_SELECTION, UsageQuerySession, type UsagesScopeSelection } from "../usageQuerySession";


export function useWorkspaceUsagesState() {
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const referencesRequestSequenceRef = useRef(0);
  // §8.20.5 W4: ONE immutable usages session backs the tool window, the
  // lightweight Show Usages popup and the recent-query stack.
  const usageSessionRef = useRef<UsageQuerySession | null>(null);
  if (!usageSessionRef.current) usageSessionRef.current = new UsageQuerySession();
  useEffect(() => () => usageSessionRef.current?.dispose(), []);
  const [usagesScopeSelection, setUsagesScopeSelection] = useState<UsagesScopeSelection>({ ...DEFAULT_SCOPE_SELECTION });
  const [usagesScopeDialog, setUsagesScopeDialog] = useState<{
    open: boolean;
    file: OpenFileState;
    position: LspPosition;
  } | null>(null);
  const [usagesRecentsRevision, setUsagesRecentsRevision] = useState(0);
  // §8.19.7: pin ownership + rerun origin marker live above the panel so a
  // new Find Usages asks before replacing a pinned session and rerun targets
  // the recorded symbol identity instead of the current caret.
  const referencesPinnedRef = useRef(false);
  const [referencesPinned, setReferencesPinned] = useState(false);
  referencesPinnedRef.current = referencesPinned;
  const referencesRerunRef = useRef<{
    fileKey: string;
    uri: string;
    position: LspPosition;
    symbolName: string;
  } | null>(null);
  const findReferencesRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<void>>(async () => { });
  const setPinned = useCallback((pinned: boolean) => {
    setReferencesPinned(pinned);
    usageSessionRef.current?.setPinned(pinned);
  }, []);
  const restoreRecent = useCallback((id: string) => {
    usageSessionRef.current?.restore(id);
    setUsagesRecentsRevision((revision) => revision + 1);
  }, []);
  const recentSessions = usageSessionRef.current?.getRecent().map((snapshot) => ({
    id: snapshot.id,
    label: `${snapshot.symbol.displayName || "symbol"} · ${snapshot.envelope.results.length} · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
  })) ?? [];
  return { setPinned, restoreRecent, recentSessions, findReferencesRef, usageSessionRef, referencesRequestSequenceRef, setReferencesResult, referencesRerunRef, setUsagesRecentsRevision, referencesPinnedRef, setUsagesScopeDialog, setUsagesScopeSelection, usagesScopeDialog, usagesScopeSelection, referencesResult, referencesPinned, setReferencesPinned, usagesRecentsRevision };
}

export type WorkspaceUsagesState = ReturnType<typeof useWorkspaceUsagesState>;

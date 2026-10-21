import { useEffect, useMemo, useState } from "react";
import { ReferenceInfoController, type ReferenceHistorySnapshot } from "../referenceInfoController";
import { ParameterInfoSession, type ParameterDisplayState } from "../referenceInfoSession";


export interface UseWorkspaceReferenceSessionsContext {
  workspaceInstanceId: string;
}

export function useWorkspaceReferenceSessions(context: UseWorkspaceReferenceSessionsContext) {
  const { workspaceInstanceId } = context;
  const referenceInfoController = useMemo(
    () => new ReferenceInfoController(workspaceInstanceId),
    [workspaceInstanceId],
  );
  // §8.20.2 W1: the ONLY Parameter Info request sequence lives in this
  // session; the editor host is a pure display adapter.
  const parameterInfoSession = useMemo(
    () => new ParameterInfoSession(referenceInfoController),
    [referenceInfoController],
  );
  const [parameterPopup, setParameterPopup] = useState<ParameterDisplayState>({ phase: "hidden" });
  const [referenceHistory, setReferenceHistory] = useState<ReferenceHistorySnapshot>(
    () => referenceInfoController.historySnapshot(),
  );
  useEffect(() => {
    referenceInfoController.activate();
    setReferenceHistory(referenceInfoController.historySnapshot());
    return () => referenceInfoController.dispose();
  }, [referenceInfoController]);
  useEffect(() => {
    const unsubscribe = parameterInfoSession.subscribe(setParameterPopup);
    return () => {
      unsubscribe();
      parameterInfoSession.dispose();
    };
  }, [parameterInfoSession]);
  return { parameterInfoSession, setReferenceHistory, referenceInfoController, parameterPopup, referenceHistory };
}

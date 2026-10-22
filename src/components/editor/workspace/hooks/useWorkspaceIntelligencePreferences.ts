import { useCallback, useEffect, useRef, useState } from "react";
import { readWorkspaceIntelligencePreferences, writeWorkspaceIntelligencePreferences, type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { WorkspaceLspSessionManager } from "../workspaceLspSessionManager";


export interface UseWorkspaceIntelligencePreferencesContext {
  workspaceInstanceId: string;
  parameterInfoSession: import("../referenceInfoSession").ParameterInfoSession;
}

export function useWorkspaceIntelligencePreferences(context: UseWorkspaceIntelligencePreferencesContext) {
  const { workspaceInstanceId, parameterInfoSession } = context;
  const [intelligencePreferences, setIntelligencePreferencesState] = useState<WorkspaceIntelligencePreferences>(
    () => readWorkspaceIntelligencePreferences(workspaceInstanceId),
  );
  useEffect(() => {
    setIntelligencePreferencesState(readWorkspaceIntelligencePreferences(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const [parameterInfoRequestNonce, setParameterInfoRequestNonce] = useState(0);
  // 迁移时保留用户现值: persisted auto-popup/delay values flow straight into
  // the session; defaults never overwrite them.
  useEffect(() => {
    parameterInfoSession.setPreferences(intelligencePreferences.parameterInfo);
  }, [intelligencePreferences.parameterInfo, parameterInfoSession]);
  const workspaceLspSessionManagerRef = useRef<WorkspaceLspSessionManager | null>(null);
  if (!workspaceLspSessionManagerRef.current) {
    workspaceLspSessionManagerRef.current = new WorkspaceLspSessionManager(intelligencePreferences.completion);
  }
  useEffect(() => {
    workspaceLspSessionManagerRef.current?.setCompletionPreferences(intelligencePreferences.completion);
  }, [intelligencePreferences.completion]);
  const [intelligenceSettingsOpen, setIntelligenceSettingsOpen] = useState(false);
  const setIntelligencePreferences = useCallback((
    update: WorkspaceIntelligencePreferences
      | ((current: WorkspaceIntelligencePreferences) => WorkspaceIntelligencePreferences),
  ) => {
    setIntelligencePreferencesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return writeWorkspaceIntelligencePreferences(workspaceInstanceId, next);
    });
  }, [workspaceInstanceId]);
  return { intelligencePreferences, setIntelligencePreferences, setParameterInfoRequestNonce, setIntelligenceSettingsOpen, parameterInfoRequestNonce, workspaceLspSessionManagerRef, intelligenceSettingsOpen };
}

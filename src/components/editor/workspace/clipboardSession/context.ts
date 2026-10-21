import { createContext, useContext } from "react";
import { type WorkspaceClipboardHandle } from "./model";

export const WorkspaceClipboardSessionContext = createContext<WorkspaceClipboardHandle | null>(null);

export function useWorkspaceClipboardSession(): WorkspaceClipboardHandle | null {
  return useContext(WorkspaceClipboardSessionContext);
}

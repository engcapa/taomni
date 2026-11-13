import { createContext, useContext } from "react";
import type { ExplorerOperations } from "./useExplorerOperations";

export interface ExplorerViewContext {
  operations: ExplorerOperations;
  dropPath: string | null;
  onOpenExplorer: (path: string, forceNew?: boolean) => void;
  onOpenTerminal: (path: string) => void;
  onProperties: () => void;
}
export const ExplorerContext = createContext<ExplorerViewContext | null>(null);
export function useExplorerContext() {
  const context = useContext(ExplorerContext);
  if (!context) throw new Error("Explorer list requires ExplorerShell");
  return context;
}

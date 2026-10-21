import { useRef } from "react";
import { type TreeOpenIntent } from "../controller/mutationTypes";


export interface UseWorkspaceTreeFocusStateContext {

}

export function useWorkspaceTreeFocusState(context: UseWorkspaceTreeFocusStateContext) {
  const { } = context;
  const treeInteractionEpochRef = useRef(0);
  const treeOpenRequestIdRef = useRef(0);
  const pendingTreeOpenIntentRef = useRef<TreeOpenIntent | null>(null);
  const tryGrantTreeFocusRef = useRef<(intent: TreeOpenIntent, canonicalKey: string) => boolean>(() => false);
  const treePaneRef = useRef<HTMLElement | null>(null);
  return {
    pendingTreeOpenIntentRef,
    tryGrantTreeFocusRef,
    treePaneRef,
    treeInteractionEpochRef,
    treeOpenRequestIdRef,
  };
}

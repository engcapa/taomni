import { useCallback,useMemo,useState } from "react";
import { type WatchExpressionItem } from "./types";
import { readWatches,watchesKey } from "./breakpointPersistence";


export interface UseDebugWatchesContext {
  workspaceInstanceId: string;
}

export function useDebugWatches(context: UseDebugWatchesContext) {
  const { workspaceInstanceId }=context;
  const [watchItems,setWatchItems]=useState<WatchExpressionItem[]>(() => {
    let counter=0;
    return readWatches(workspaceInstanceId).map((expr) => ({
      id: `watch-${Date.now()}-${++counter}`,
      expression: expr,
      enabled: true,
    }));
  });
  const watchExpressions=useMemo(() => watchItems.map((w) => w.expression),[watchItems]);

  const persistWatches=useCallback((next: string[]) => {
    try {
      window.localStorage.setItem(watchesKey(workspaceInstanceId),JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const addWatchExpression=useCallback((expr: string) => {
    const trimmed=expr.trim();
    if(!trimmed) return;
    const newId=`watch-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const newItem: WatchExpressionItem={
      id: newId,
      expression: trimmed,
      enabled: true,
    };
    setWatchItems((current) => {
      if(current.some((item) => item.expression===trimmed)) {
        return current;
      }
      const next=[...current,newItem];
      persistWatches(next.map((w) => w.expression));
      return next;
    });
    return newId;
  },[persistWatches]);

  const removeWatchExpression=useCallback((target: number|string) => {
    setWatchItems((current) => {
      let next: WatchExpressionItem[];
      if(typeof target==="number") {
        next=current.filter((_,i) => i!==target);
      } else {
        const hasIdMatch=current.some((item) => item.id===target);
        if(hasIdMatch) {
          next=current.filter((item) => item.id!==target);
        } else {
          const idx=current.findIndex((item) => item.expression===target);
          if(idx!==-1) {
            next=[...current.slice(0,idx),...current.slice(idx+1)];
          } else {
            next=current;
          }
        }
      }
      persistWatches(next.map((w) => w.expression));
      return next;
    });
  },[persistWatches]);
  return { watchExpressions,watchItems,addWatchExpression,removeWatchExpression };
}

import { useEffect } from "react";
import { isAgentRunActive, useOrchestrationStore } from "../../../stores/orchestrationStore";

/** Poll only live runs; renderer lifecycle never cancels native work. */
export function useOrchestrationRuntime() {
  const selectedId = useOrchestrationStore((state) => state.selectedRunId);
  const live = useOrchestrationStore((state) => state.runs.some(isAgentRunActive));
  useEffect(() => { void useOrchestrationStore.getState().load(); }, []);
  useEffect(() => {
    if (selectedId) void useOrchestrationStore.getState().refreshRun(selectedId).catch(() => {});
  }, [selectedId]);
  useEffect(() => {
    const refresh = () => { void useOrchestrationStore.getState().refreshRuntime().catch(() => {}); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (!live) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await useOrchestrationStore.getState().refreshRuntime().catch(() => {});
      if (!disposed) timer = setTimeout(() => { void tick(); }, 1800);
    };
    timer = setTimeout(() => { void tick(); }, 1800);
    return () => { disposed = true; clearTimeout(timer); };
  }, [live]);
}

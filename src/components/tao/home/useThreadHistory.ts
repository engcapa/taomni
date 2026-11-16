import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../../../lib/runtime";
import { useChatStore } from "../../../stores/chatStore";
import { nativeThreadStorage } from "../ai-chat/backend";
import type { TaoChatController, TaoThread } from "../ai-chat";
import { taoText as tr } from "../i18n";
import { createThreadHistoryStorage } from "./threadHistoryStorage";

/** Own history hydration, autosave and deletion together, independently of the
 * history popup's lifetime. Legacy rows retain their original store ownership. */
export function useThreadHistory(controller: TaoChatController) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isTauriRuntime());
  const [attempt, setAttempt] = useState(0);
  const hydrated = useRef(false);
  const queued = useRef(new Map<string, TaoThread>());
  const owner = useRef<ReturnType<typeof createThreadHistoryStorage> | null>(null);
  if (!owner.current) owner.current = createThreadHistoryStorage({
    save: (thread) => nativeThreadStorage.save(thread),
    remove: async (thread) => {
      if (thread.source === "legacy") {
        const chat = useChatStore.getState();
        if (chat.sendingByThreadId[thread.id]) throw new Error(tr("请先停止对话后再删除。"));
        await chat.deleteThread(thread.id);
      } else if (isTauriRuntime()) await nativeThreadStorage.remove(thread.id);
    },
  });

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = hydrated.current;
    const flush = async () => {
      const threads = Object.values(controller.getState().threads).filter((thread) => thread.source !== "legacy" &&
        (thread.messages.length || thread.preferences?.composer.text.trim() || thread.preferences?.composer.chips.length) && queued.current.get(thread.id) !== thread);
      try {
        await Promise.all(threads.map(async (thread) => {
          queued.current.set(thread.id, thread);
          try { await owner.current!.save(thread); }
          catch (cause) { if (queued.current.get(thread.id) === thread) queued.current.delete(thread.id); throw cause; }
        }));
        if (!disposed && threads.length) setError("");
      } catch (cause) { if (!disposed) setError(tr("历史保存失败：{error}", { error: String(cause) })); }
    };
    const save = () => {
      if (!loaded || timer) return;
      timer = setTimeout(() => {
        timer = undefined; void flush();
      }, 180);
    };
    const unsubscribe = controller.subscribe(save);
    setLoading(true);
    void nativeThreadStorage.load().then((threads) => {
      if (disposed) return;
      const state = controller.getState();
      const changed = Object.values(state.threads).some((thread) => thread.messages.length || thread.preferences?.composer.text.trim() || thread.preferences?.composer.chips.length) || Object.keys(state.threads).length > 1;
      controller.hydrateThreads(threads, { merge: hydrated.current || changed });
      hydrated.current = true; loaded = true; setLoading(false); setError(""); save();
    }).catch((cause) => {
      if (!disposed) { setError(tr("历史读取失败：{error}", { error: String(cause) })); loaded = true; setLoading(false); }
    });
    const leave = () => { clearTimeout(timer); timer = undefined; void flush(); };
    const visibility = () => { if (document.visibilityState === "hidden") leave(); };
    window.addEventListener("pagehide", leave); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; unsubscribe(); clearTimeout(timer); window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", visibility); void flush(); };
  }, [controller, attempt]);

  const remove = async (thread: TaoThread) => {
    if (!await controller.deleteThread(thread.id, owner.current!.remove)) throw new Error(tr("请先停止对话后再删除。"));
  };
  return { loading, error, remove, refresh: () => setAttempt((value) => value + 1) };
}

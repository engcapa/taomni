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
    let loaded = false;
    const save = () => {
      if (!loaded) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const thread of Object.values(controller.getState().threads)) {
          void owner.current!.save(thread).catch((cause) => {
            if (!disposed) setError(tr("历史保存失败：{error}", { error: String(cause) }));
          });
        }
      }, 180);
    };
    const unsubscribe = controller.subscribe(save);
    void nativeThreadStorage.load().then((threads) => {
      if (disposed) return;
      controller.hydrateThreads(threads); loaded = true; setLoading(false); save();
    }).catch((cause) => {
      if (!disposed) { setError(tr("历史读取失败：{error}", { error: String(cause) })); loaded = true; setLoading(false); }
    });
    return () => { disposed = true; unsubscribe(); clearTimeout(timer); };
  }, [controller]);

  const remove = async (thread: TaoThread) => {
    if (!await controller.deleteThread(thread.id, owner.current!.remove)) throw new Error(tr("请先停止对话后再删除。"));
  };
  return { loading, error, remove };
}

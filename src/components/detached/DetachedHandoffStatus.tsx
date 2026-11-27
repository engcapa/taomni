import { useState } from "react";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { Button } from "../ui/Button";
import { usePendingAction } from "../ui/usePendingAction";

export function DetachedHandoffStatus({ sessionId, failed }: { sessionId: string; failed: boolean }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const close = usePendingAction(async () => {
    setError(null);
    try {
      if (isTauriRuntime()) await closeCurrentDetachedWindow();
      else window.close();
    } catch (cause) {
      setError(String(cause));
    }
  });
  return (
    <main
      data-testid="detached-handoff"
      className="w-screen h-screen overflow-auto grid place-items-center p-6 text-ui-body"
      style={{ background: "var(--taomni-bg, Canvas)", color: "var(--taomni-text, CanvasText)" }}
    >
      <div className="max-w-md text-center leading-relaxed">
        <div role="status" aria-atomic="true">
          <h1 className="text-ui-title font-semibold mb-2">
            {t(failed ? "fileBrowser.detachedTimedOutTitle" : "fileBrowser.detachedLoadingTitle")}
          </h1>
          <p className="break-words">
            {failed ? t("fileBrowser.detachedTimedOutBody", { sessionId }) : t("fileBrowser.detachedLoadingBody")}
          </p>
          {failed && <p className="mt-3">{t("fileBrowser.detachedTimedOutHint")}</p>}
        </div>
        {failed && (
          <Button data-testid="detached-handoff-close" className="mt-4" busy={close.busy} onClick={() => void close.run()}>
            {t("fileBrowser.detachedCloseWindow")}
          </Button>
        )}
        {error && <p role="alert" className="mt-2 text-ui-danger">{error}</p>}
      </div>
    </main>
  );
}

import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { useServersStore } from "../../stores/serversStore";

/** Notice dialog shown when another running Taomni instance already owns the Local servers tab. */
export function ServersTabBlockedDialog() {
  const t = useT();
  const message = useServersStore((s) => s.tabBlockedMessage);
  const setTabBlockedMessage = useServersStore((s) => s.setTabBlockedMessage);
  const okButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (message) {
      okButtonRef.current?.focus();
    }
  }, [message]);

  if (!message) return null;

  const dismiss = () => setTabBlockedMessage(null);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={dismiss}
      onKeyDown={handleKeyDown}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t("servers.tabAlreadyOpenTitle")}
        data-testid="servers-blocked-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{t("servers.tabAlreadyOpenTitle")}</div>
        <div
          data-testid="servers-blocked-message"
          className="text-[12px] mb-4 whitespace-pre-line"
          style={{ color: "var(--taomni-text)" }}
        >
          {message}
        </div>
        <div className="flex justify-end">
          <button
            ref={okButtonRef}
            type="button"
            data-testid="servers-blocked-ok"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={dismiss}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

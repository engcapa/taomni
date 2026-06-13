import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";

export interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const t = useT();
  const { status: updateStatus, availableVersion, check } = useUpdateStore();

  const updateStatusText =
    updateStatus === "checking"
      ? t("update.statusChecking")
      : updateStatus === "uptodate"
        ? t("update.statusUpToDate")
        : updateStatus === "available"
          ? t("update.statusAvailable", { version: availableVersion ?? "" })
          : updateStatus === "error"
            ? t("update.statusError")
            : "";

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={t("about.title")}
        aria-modal="true"
        data-testid="about-dialog"
        className="w-[380px] rounded shadow-lg p-5"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl shrink-0"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            N
          </div>
          <div>
            <div className="text-lg font-semibold">{t("app.name")}</div>
            <div
              data-testid="about-version"
              className="text-[12px] taomni-mono"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {t("about.version", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <div className="text-[12px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
          {t("about.description")}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="taomni-btn h-8 px-3 text-[12px] shrink-0"
              disabled={updateStatus === "checking"}
              onClick={() => void check({ manual: true })}
              data-testid="about-check-update"
            >
              {t("update.checkButton")}
            </button>
            {updateStatusText && (
              <span
                className="text-[12px] truncate"
                style={{ color: "var(--taomni-text-muted)" }}
                data-testid="about-update-status"
              >
                {updateStatusText}
              </span>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="taomni-btn h-8 px-4"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

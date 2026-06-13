import { useUpdateStore } from "../stores/updateStore";
import { useT, type TranslateFn } from "../lib/i18n";

const DANGER = "#e5534b";

// macOS arch tokens get friendly names; other OSes only ever have one
// candidate, so the raw arch is fine there.
function archLabel(t: TranslateFn, os: string | null, target: string): string {
  const arch = target.split("-")[1] ?? target;
  if (os === "darwin") {
    if (arch === "aarch64") return t("update.archAppleSilicon");
    if (arch === "x86_64") return t("update.archIntel");
  }
  return arch;
}

/**
 * Update prompt with two explicit confirmation gates:
 *   #1 — nothing downloads/installs until the user clicks "Download and install"
 *   #2 — the app never restarts on its own; the user clicks "Restart now"
 * Plus a package/arch selector when more than one build can run on this machine.
 */
export function UpdateDialog() {
  const t = useT();
  const s = useUpdateStore();
  if (!s.dialogOpen) return null;

  const showArch = s.candidates.length > 1;
  const downloading = s.status === "downloading";
  const percent = s.progress?.percent ?? null;
  const installing = downloading && percent === 100;
  const canDownload =
    s.status === "available" && s.targetStatus !== "checking" && s.targetStatus !== "unavailable";
  const dismissable = !downloading;

  const title =
    s.status === "error"
      ? t("update.errorTitle")
      : s.status === "ready"
        ? t("update.readyTitle")
        : s.status === "uptodate"
          ? t("update.upToDateTitle")
          : t("update.title");

  const close = () => {
    if (dismissable) s.closeDialog();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        data-testid="update-dialog"
        className="w-[440px] rounded shadow-lg p-5"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold mb-3">{title}</div>

        {s.status === "uptodate" && (
          <div className="text-[13px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
            {t("update.statusUpToDate")}
          </div>
        )}

        {s.status === "error" && (
          <div data-testid="update-error" className="text-[13px] mb-4" style={{ color: DANGER }}>
            {s.error}
          </div>
        )}

        {s.status === "ready" && (
          <div className="text-[13px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
            {t("update.readyBody", { version: s.availableVersion ?? "" })}
          </div>
        )}

        {(s.status === "available" || downloading) && (
          <>
            <div className="text-[12px] taomni-mono mb-1" style={{ color: "var(--taomni-text-muted)" }}>
              {t("update.currentVersion", { version: s.currentVersion ?? "" })} →{" "}
              {t("update.newVersion", { version: s.availableVersion ?? "" })}
            </div>
            <div className="text-[13px] font-medium mt-3 mb-1">{t("update.notesTitle")}</div>
            <div
              className="text-[12px] mb-3 max-h-40 overflow-auto whitespace-pre-wrap"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {s.notes || t("update.noNotes")}
            </div>

            {showArch && (
              <div className="mb-3">
                <div className="text-[13px] font-medium mb-1">{t("update.archTitle")}</div>
                <div className="flex flex-wrap gap-2">
                  {s.candidates.map((target) => {
                    const selected = s.selectedTarget === target;
                    const tags = [
                      target === s.nativeTarget ? t("update.archCurrent") : null,
                      target === s.recommendedTarget ? t("update.archRecommended") : null,
                    ].filter(Boolean);
                    return (
                      <button
                        key={target}
                        type="button"
                        disabled={downloading}
                        onClick={() => void s.setSelectedTarget(target)}
                        className="taomni-btn h-8 px-3 text-[12px]"
                        data-primary={selected ? "true" : undefined}
                        data-testid={`update-arch-${target}`}
                        aria-pressed={selected}
                      >
                        {archLabel(t, s.os, target)}
                        {tags.length ? ` · ${tags.join(" · ")}` : ""}
                      </button>
                    );
                  })}
                </div>
                {s.targetStatus === "checking" && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--taomni-text-muted)" }}>
                    {t("update.archChecking")}
                  </div>
                )}
                {s.targetStatus === "unavailable" && (
                  <div className="text-[12px] mt-1" style={{ color: DANGER }}>
                    {t("update.archUnavailable")}
                  </div>
                )}
                {s.isRosetta && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--taomni-warning-text)" }}>
                    {t("update.rosettaHint")}
                  </div>
                )}
              </div>
            )}

            {downloading && (
              <div className="mb-3" data-testid="update-progress">
                <div className="h-2 rounded overflow-hidden" style={{ background: "var(--taomni-card-border)" }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${percent ?? 0}%`,
                      background: "linear-gradient(90deg, #1e5fa8, #62d36f)",
                      transition: "width 120ms linear",
                    }}
                  />
                </div>
                <div className="text-[12px] mt-1" style={{ color: "var(--taomni-text-muted)" }}>
                  {installing
                    ? t("update.installing")
                    : percent === null
                      ? t("update.downloadingUnknown")
                      : t("update.downloading", { percent })}
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 mt-2">
          {s.status === "available" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("update.later")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                disabled={!canDownload}
                onClick={() => void s.startDownload()}
                data-testid="update-download"
              >
                {t("update.downloadAndInstall")}
              </button>
            </>
          )}
          {s.status === "ready" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("update.later")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                onClick={() => void s.restart()}
                data-testid="update-restart"
              >
                {t("update.restartNow")}
              </button>
            </>
          )}
          {s.status === "error" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                onClick={() => void s.check({ manual: true })}
              >
                {t("update.retry")}
              </button>
            </>
          )}
          {(s.status === "uptodate" || s.status === "checking") && (
            <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

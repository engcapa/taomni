import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  ExternalLink,
  FolderSync,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  DEFAULT_SFTP_PREFERENCES,
  loadSftpPreferences,
  normalizeSftpPreferences,
  saveSftpPreferences,
  subscribeSftpPreferences,
  type SftpLocalDoubleClickAction,
  type SftpPreferences,
} from "../../lib/sftpPreferences";

const ACTIONS: Array<{
  value: SftpLocalDoubleClickAction;
  labelKey: string;
  hintKey: string;
  testId: string;
  icon: ReactNode;
  isDefault?: boolean;
}> = [
  {
    value: "open",
    labelKey: "settings.sftpLocalDoubleClickOpen",
    hintKey: "settings.sftpLocalDoubleClickOpenHint",
    testId: "sftp-local-double-click-open",
    icon: <ExternalLink className="h-4 w-4" />,
    isDefault: true,
  },
  {
    value: "upload",
    labelKey: "settings.sftpLocalDoubleClickUpload",
    hintKey: "settings.sftpLocalDoubleClickUploadHint",
    testId: "sftp-local-double-click-upload",
    icon: <Upload className="h-4 w-4" />,
  },
];

export function SftpSettings() {
  const t = useT();
  const [preferences, setPreferences] = useState(loadSftpPreferences);

  useEffect(() => subscribeSftpPreferences(setPreferences), []);

  const updatePreferences = (patch: Partial<SftpPreferences>) => {
    const next = normalizeSftpPreferences({ ...preferences, ...patch });
    setPreferences(next);
    saveSftpPreferences(next);
  };

  return (
    <section
      data-testid="sftp-settings"
      className="mb-5 overflow-hidden rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]"
    >
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-[var(--taomni-divider)] px-3.5 py-3">
        <div
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md"
          style={{
            background: "color-mix(in srgb, var(--taomni-accent) 14%, transparent)",
            color: "var(--taomni-accent)",
          }}
        >
          <FolderSync className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-tight">
            {t("settings.sftpTitle")}
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-[var(--taomni-text-muted)]">
            {t("settings.sftpSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="sftp-settings-reset"
          className="taomni-btn ml-1 h-7 shrink-0 px-2.5 inline-flex items-center gap-1 text-[11px]"
          onClick={() => {
            setPreferences(DEFAULT_SFTP_PREFERENCES);
            saveSftpPreferences(DEFAULT_SFTP_PREFERENCES);
          }}
          title={t("settings.sftpResetTitle")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("settings.reset")}
        </button>
      </div>

      {/* Body */}
      <div className="space-y-3 px-3.5 py-3.5">
        <div>
          <div className="text-[12px] font-medium">
            {t("settings.sftpLocalDoubleClickLabel")}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-[var(--taomni-text-muted)]">
            {t("settings.sftpLocalDoubleClickHint")}
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label={t("settings.sftpLocalDoubleClickLabel")}
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {ACTIONS.map((action) => {
            const active = preferences.localDoubleClickAction === action.value;
            return (
              <button
                key={action.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={action.testId}
                data-active={active || undefined}
                onClick={() => updatePreferences({ localDoubleClickAction: action.value })}
                className="group relative flex h-full flex-col gap-2.5 rounded-lg border px-3 py-3 text-left transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--taomni-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--taomni-panel-bg)]"
                style={
                  active
                    ? {
                        borderColor: "var(--taomni-accent)",
                        background:
                          "color-mix(in srgb, var(--taomni-accent) 12%, var(--taomni-panel-bg))",
                        boxShadow:
                          "0 0 0 1px color-mix(in srgb, var(--taomni-accent) 40%, transparent)",
                      }
                    : {
                        borderColor: "var(--taomni-divider)",
                        background: "var(--taomni-bg)",
                      }
                }
                onMouseEnter={(e) => {
                  if (active) return;
                  e.currentTarget.style.borderColor =
                    "color-mix(in srgb, var(--taomni-accent) 45%, var(--taomni-divider))";
                  e.currentTarget.style.background =
                    "color-mix(in srgb, var(--taomni-accent) 6%, var(--taomni-bg))";
                }}
                onMouseLeave={(e) => {
                  if (active) return;
                  e.currentTarget.style.borderColor = "var(--taomni-divider)";
                  e.currentTarget.style.background = "var(--taomni-bg)";
                }}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors"
                    style={
                      active
                        ? {
                            background:
                              "color-mix(in srgb, var(--taomni-accent) 22%, transparent)",
                            color: "var(--taomni-accent)",
                          }
                        : {
                            background: "var(--taomni-panel-bg)",
                            color: "var(--taomni-text-muted)",
                            border: "1px solid var(--taomni-divider)",
                          }
                    }
                    aria-hidden
                  >
                    {action.icon}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12.5px] font-semibold leading-tight">
                        {t(action.labelKey)}
                      </span>
                      {action.isDefault ? (
                        <span
                          className="rounded px-1.5 py-px text-[10px] font-medium leading-4"
                          style={{
                            background: active
                              ? "color-mix(in srgb, var(--taomni-accent) 18%, transparent)"
                              : "var(--taomni-panel-bg)",
                            color: active
                              ? "var(--taomni-accent)"
                              : "var(--taomni-text-muted)",
                            border: "1px solid var(--taomni-divider)",
                          }}
                        >
                          {t("common.default")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span
                    className="mt-0.5 grid shrink-0 place-items-center rounded-full border transition-colors"
                    style={
                      active
                        ? {
                            borderColor: "var(--taomni-accent)",
                            background: "var(--taomni-accent)",
                            color: "var(--taomni-panel-bg)",
                            width: 18,
                            height: 18,
                          }
                        : {
                            borderColor: "var(--taomni-divider)",
                            background: "transparent",
                            width: 18,
                            height: 18,
                          }
                    }
                    aria-hidden
                  >
                    {active ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-[var(--taomni-text-muted)]">
                  {t(action.hintKey)}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

import { useState } from "react";
import { Globe, Link2, X } from "lucide-react";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";
import { useT } from "../../lib/i18n";

interface NewThreadFormatPickerProps {
  /** Initial format selection (typically pulled from the global default). */
  defaultFormat: ChatOutputFormat;
  /** Whether the new thread should be linked to the active terminal by default. */
  defaultScope: "terminal" | "global";
  /**
   * Title of the active terminal, shown next to the "bound" radio so the user
   * can confirm which terminal the new thread will be linked to. Null when no
   * terminal panel is currently focused.
   */
  activeTerminalTitle: string | null;
  onCancel: () => void;
  onConfirm: (format: ChatOutputFormat | null, scope: "terminal" | "global") => Promise<void> | void;
}

/**
 * Modal shown right before creating a new chat thread. Forces the user to
 * commit to:
 *   - an output format (md / html / plain) — locked once the first message
 *     is sent, since rendering existing assistant replies in another format
 *     silently corrupts them; the convert button on the toolbar is the
 *     escape hatch for changing the *display* without touching the contract
 *     with the LLM.
 *   - a scope (this terminal vs global) — drives the `linked_session_id`
 *     column on the thread row.
 *
 * The "Use global default" option for format means we'll write `null` to
 * `output_format` so the thread inherits AiConfig.chat_output_format.
 */
export function NewThreadFormatPicker({
  defaultFormat,
  defaultScope,
  activeTerminalTitle,
  onCancel,
  onConfirm,
}: NewThreadFormatPickerProps) {
  const t = useT();
  const [format, setFormat] = useState<ChatOutputFormat | "inherit">("inherit");
  const [scope, setScope] = useState<"terminal" | "global">(
    activeTerminalTitle ? defaultScope : "global",
  );
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const fmt = format === "inherit" ? null : format;
      await onConfirm(fmt, scope);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-[300px] max-w-[90%] rounded-lg border border-[var(--moba-divider)] shadow-xl"
        style={{ background: "var(--moba-panel-bg)" }}
        role="dialog"
        aria-label={t("chat.pickerDialogAria")}
      >
        <div className="flex items-center px-3 py-2 border-b border-[var(--moba-divider)]">
          <span className="text-[12px] font-semibold flex-1">{t("chat.pickerTitle")}</span>
          <button
            type="button"
            className="moba-btn h-5 w-5 p-0 inline-flex items-center justify-center"
            onClick={onCancel}
            aria-label={t("chat.pickerCancel")}
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        <div className="p-3 space-y-3">
          <fieldset className="space-y-1">
            <legend className="text-[11px] font-semibold mb-1">{t("chat.pickerScopeLegend")}</legend>
            <label className="flex items-start gap-2 text-[11px] cursor-pointer">
              <input
                type="radio"
                name="scope"
                value="terminal"
                checked={scope === "terminal"}
                onChange={() => setScope("terminal")}
                disabled={!activeTerminalTitle}
              />
              <span className="flex-1">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Link2 className="w-2.5 h-2.5" />
                  {t("chat.pickerBindToTerminal")}
                </span>
                <span className="block text-[10px] text-[var(--moba-text-muted)]">
                  {activeTerminalTitle
                    ? t("chat.pickerBindHelp", { title: activeTerminalTitle })
                    : t("chat.pickerBindNoTerminal")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[11px] cursor-pointer">
              <input
                type="radio"
                name="scope"
                value="global"
                checked={scope === "global"}
                onChange={() => setScope("global")}
              />
              <span className="flex-1">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Globe className="w-2.5 h-2.5" />
                  {t("chat.pickerGlobal")}
                </span>
                <span className="block text-[10px] text-[var(--moba-text-muted)]">
                  {t("chat.pickerGlobalDesc")}
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset className="space-y-1">
            <legend className="text-[11px] font-semibold mb-1">{t("chat.pickerFormatLegend")}</legend>
            {(["inherit", "md", "html", "plain"] as const).map((opt) => {
              const labels: Record<typeof opt, string> = {
                inherit: t("chat.pickerInheritFormat", { format: defaultFormat }),
                md: t("chat.formatMd"),
                html: t("chat.formatHtml"),
                plain: t("chat.formatPlainOption"),
              };
              return (
                <label
                  key={opt}
                  className="flex items-center gap-2 text-[11px] cursor-pointer"
                >
                  <input
                    type="radio"
                    name="format"
                    value={opt}
                    checked={format === opt}
                    onChange={() => setFormat(opt)}
                  />
                  <span>{labels[opt]}</span>
                </label>
              );
            })}
            <p className="text-[10px] text-[var(--moba-text-muted)] mt-1">
              {t("chat.pickerFormatTip")}
            </p>
          </fieldset>
        </div>

        <div className="flex justify-end gap-1.5 px-3 py-2 border-t border-[var(--moba-divider)]">
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[11px]"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("chat.pickerCancel")}
          </button>
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[11px] bg-[var(--moba-accent)] text-white"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? t("chat.pickerSubmitting") : t("chat.pickerCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}

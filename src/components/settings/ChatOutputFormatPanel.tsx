import { FileText } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";

/**
 * Global default for the chat output format. Each thread can still override
 * this through the format dropdown in the Chat Drawer header. The selected
 * value is also injected into the assistant's system prompt so the model
 * actually produces the expected shape.
 */
export function ChatOutputFormatPanel() {
  const { config, saveConfig } = useAiStore();
  const t = useT();
  if (!config) return null;

  const FORMAT_OPTIONS = [
    {
      value: "md",
      label: t("aiSettings.chatFormatMarkdown"),
      desc: t("aiSettings.chatFormatMarkdownDesc"),
    },
    {
      value: "html",
      label: t("aiSettings.chatFormatHtml"),
      desc: t("aiSettings.chatFormatHtmlDesc"),
    },
    {
      value: "plain",
      label: t("aiSettings.chatFormatPlain"),
      desc: t("aiSettings.chatFormatPlainDesc"),
    },
  ] as const;

  const current = config.chat_output_format ?? "md";

  const update = async (next: string) => {
    if (next === current) return;
    await saveConfig({ ...config, chat_output_format: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="text-[13px] font-semibold flex-1">{t("aiSettings.chatFormatTitle")}</div>
      </div>
      <div className="text-[11px] text-[var(--taomni-text-muted)] -mt-1">
        {t("aiSettings.chatFormatDesc")}
      </div>
      <div className="space-y-1 pt-1">
        {FORMAT_OPTIONS.map(({ value, label, desc }) => (
          <label key={value} className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="chat-output-format"
              value={value}
              checked={current === value}
              onChange={() => void update(value)}
              className="mt-0.5 accent-[var(--taomni-accent)]"
            />
            <div>
              <div className="text-[12px]">{label}</div>
              <div className="text-[10px] text-[var(--taomni-text-muted)]">{desc}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

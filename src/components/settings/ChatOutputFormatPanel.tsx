import { FileText } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";

const FORMAT_OPTIONS = [
  {
    value: "md",
    label: "Markdown (recommended)",
    desc: "Lists, code blocks, tables — rendered with marked + DOMPurify",
  },
  {
    value: "html",
    label: "HTML",
    desc: "Trust the model to emit raw HTML; output is sanitised before display",
  },
  {
    value: "plain",
    label: "Plain text",
    desc: "No markup — preserves whitespace, no DOM injection at all",
  },
] as const;

/**
 * Global default for the chat output format. Each thread can still override
 * this through the format dropdown in the Chat Drawer header. The selected
 * value is also injected into the assistant's system prompt so the model
 * actually produces the expected shape.
 */
export function ChatOutputFormatPanel() {
  const { config, saveConfig } = useAiStore();
  if (!config) return null;

  const current = config.chat_output_format ?? "md";

  const update = async (next: string) => {
    if (next === current) return;
    await saveConfig({ ...config, chat_output_format: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-[var(--moba-accent)]" />
        <div className="text-[13px] font-semibold flex-1">Chat output format</div>
      </div>
      <div className="text-[11px] text-[var(--moba-text-muted)] -mt-1">
        How assistant replies are formatted by default. Per-thread overrides live in the drawer header.
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
              className="mt-0.5 accent-[var(--moba-accent)]"
            />
            <div>
              <div className="text-[12px]">{label}</div>
              <div className="text-[10px] text-[var(--moba-text-muted)]">{desc}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

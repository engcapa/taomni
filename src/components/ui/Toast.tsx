import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./IconButton";
import { writeText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";

export { ToastStack, useToastQueue } from "../../../src-tauri/crates/taomni-plugin-api/frontend/ui/Toast";

export function CopyErrorDetails({ message }: { message: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const Icon = copied ? Check : Copy;
  return <>
    <IconButton className="taomni-btn size-6 shrink-0" label={t(copied ? "common.copied" : "feedback.copyDetails")}
      onClick={async () => {
        try {
          await writeText(message);
          setError("");
          setCopied(true);
        } catch (cause) {
          setError(t("feedback.copyFailed", { detail: String(cause) }));
        }
      }}>
      <Icon className="size-3.5" aria-hidden="true" />
    </IconButton>
    {error && <span role="alert">{error}</span>}
  </>;
}

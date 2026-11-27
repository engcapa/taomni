import { FileText, TriangleAlert } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { selectFilePath } from "../../../lib/ipc";
import { useT } from "../../../lib/i18n";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";

type Analysis = {
  label: string;
  title: string;
  read: (path: string) => Promise<() => void>;
};

type Props = {
  value: string;
  onChange: (path: string) => void;
  label: string;
  placeholder: string;
  testId?: string;
  analysis?: Analysis;
  browseText?: { label: string; title: string; testId: string };
};

export function SessionFilePathInput({ value, onChange, label, placeholder, testId, analysis, browseText }: Props) {
  const t = useT();
  const errorId = useId();
  const request = useRef(0);
  const [pending, setPending] = useState<"browse" | "analyze" | null>(null);
  const [error, setError] = useState<{ action: "browse" | "analyze"; detail: string } | null>(null);

  useLayoutEffect(() => {
    setError(null);
    setPending(null);
    return () => { request.current += 1; };
  }, [value]);

  async function perform(action: "browse" | "analyze") {
    const ticket = ++request.current;
    setError(null);
    setPending(action);
    try {
      if (action === "browse") {
        const selected = await selectFilePath(value || undefined);
        if (request.current === ticket && selected) onChange(selected.trim());
      } else if (analysis) {
        const apply = await analysis.read(value.trim());
        if (request.current === ticket) apply();
      }
    } catch (cause) {
      if (request.current === ticket) setError({ action, detail: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (request.current === ticket) setPending(null);
    }
  }

  return <>
    <input className={browseText ? "taomni-input flex-1" : "taomni-input w-96 min-w-0"}
      value={value} data-testid={testId} aria-label={label} placeholder={placeholder}
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error?.action === "analyze" || undefined}
      onChange={(event) => onChange(event.target.value)} />
    {browseText
      ? <Button className="ml-1" data-testid={browseText.testId} title={browseText.title}
          disabled={pending !== null} busy={pending === "browse"} onClick={() => void perform("browse")}>
          {browseText.label}
        </Button>
      : <IconButton labelKey="browseFile" className="taomni-btn px-2 shrink-0 py-1"
          disabled={pending !== null} aria-busy={pending === "browse" || undefined} onClick={() => void perform("browse")}>
          <FileText className="w-3.5 h-3.5" />
        </IconButton>}
    {analysis && <Button className="px-2 shrink-0 py-1" title={analysis.title}
      disabled={!value.trim() || pending !== null} busy={pending === "analyze"}
      onClick={() => void perform("analyze")}>{analysis.label}</Button>}
    {error && <p id={errorId} role="alert" className="flex w-full items-start gap-1 select-text break-all text-ui-danger">
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      {t(error.action === "browse" ? "sessionEditor2.pathBrowseFailed" : "sessionEditor2.pathAnalyzeFailed", { detail: error.detail })}
    </p>}
  </>;
}

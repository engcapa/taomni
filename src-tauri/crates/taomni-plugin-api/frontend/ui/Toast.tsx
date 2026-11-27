import { AlertCircle, Info, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface ToastMessage {
  message: string;
  error?: boolean;
  action?: { label: string; run: () => void; testId?: string };
}

interface ToastEntry extends ToastMessage {
  id: number;
  count: number;
}

export function useToastQueue() {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const publish = useCallback((message: ToastMessage) => {
    const entry = { ...message, count: 1, id: ++nextId.current };
    setEntries((current) => {
      // Two Undo actions can have identical labels and different file sets.
      const repeated = !entry.action && current.find((item) => !item.action &&
        item.message === entry.message && Boolean(item.error) === Boolean(entry.error));
      return repeated
        ? current.map((item) => item.id === repeated.id ? { ...item, count: item.count + 1 } : item)
        : [...current, entry];
    });
  }, []);
  const dismiss = useCallback((id: number) => {
    setEntries((current) => current.filter((item) => item.id !== id));
  }, []);
  return { entries, publish, dismiss };
}

interface ToastProps {
  entry: ToastEntry;
  dismiss: (id: number) => void;
  closeLabel: string;
  errorAction?: (message: string) => ReactNode;
  paused: boolean;
  returnFocus?: () => void;
}

function Toast({ entry, dismiss, closeLabel, errorAction, paused, returnFocus }: ToastProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const remaining = useRef(4000);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { remaining.current = 4000; }, [entry.count]);
  useEffect(() => {
    if (entry.error || hover || focus || paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => dismiss(entry.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [entry.id, entry.count, entry.error, hover, focus, paused, dismiss]);

  function close() {
    if (root.current?.contains(document.activeElement)) returnFocus?.();
    dismiss(entry.id);
  }
  const Glyph = entry.error ? AlertCircle : Info;
  return <div ref={root} className="taomni-toast" role={entry.error ? "alert" : "status"}
    data-tone={entry.error ? "error" : "info"} tabIndex={0}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setFocus(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false); }}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <Glyph aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="taomni-toast-message">{entry.message}{entry.count > 1 && ` (×${entry.count})`}</span>
    {entry.action && <button type="button" className="taomni-btn" data-testid={entry.action.testId}
      onClick={() => { close(); entry.action?.run(); }}>{entry.action.label}</button>}
    {entry.error && errorAction?.(entry.message)}
    <IconButton className="taomni-btn size-6 shrink-0" label={closeLabel} onClick={close}>
      <X aria-hidden="true" className="size-3.5" />
    </IconButton>
  </div>;
}

export function ToastStack({ entries, testId, ...props }: Omit<ToastProps, "entry"> & {
  entries: readonly ToastEntry[];
  testId?: string;
}) {
  const visible = entries.slice(0, 3);
  if (!visible.length) return null;
  return <div className={`taomni-toast-stack${visible.some((entry) => entry.error) ? " error" : ""}`} data-testid={testId}>
    {visible.map((entry) => <Toast key={entry.id} entry={entry} {...props} />)}
  </div>;
}

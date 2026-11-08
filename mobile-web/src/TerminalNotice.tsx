import { useCallback, useEffect, useRef, useState } from "react";

export const NOTICE_DURATION_MS = 6000;
type Notice = { message: string; help: boolean };

export function useTerminalNotice() {
  const [notice, setNotice] = useState<Notice | null>({ message: "", help: true });
  const latest = useRef("");
  const show = useCallback((message: string) => {
    if (!message) { setNotice(null); return; }
    latest.current = message;
    setNotice({ message, help: false });
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);
  const reopen = useCallback(() => setNotice({ message: latest.current, help: true }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  return { notice, show, dismiss, reopen };
}

export function TerminalNotice({ notice, guidance, warning, onDismiss }: {
  notice: Notice | null;
  guidance: string;
  warning: boolean;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return <div id="mobile-terminal-tip" className="terminal-toast" role="status" data-testid="mobile-terminal-toast">
    <div>
      {notice.message && <p data-testid="mobile-terminal-notice">{notice.message}</p>}
      {notice.help && <p data-testid={warning ? "mobile-control-warning" : "mobile-terminal-guidance"}>{guidance}</p>}
    </div>
    <button data-testid="mobile-terminal-notice-close" aria-label="关闭提示" onClick={onDismiss}>×</button>
  </div>;
}

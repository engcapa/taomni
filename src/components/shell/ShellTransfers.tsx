import { useLayoutEffect, useRef, useState } from "react";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useT } from "../../lib/i18n";
import { sftpCancelTransfer, sftpPauseTransfer, sftpResumeTransfer } from "../../lib/sftp";
import { FileTransferQueue } from "../filebrowser/FileTransferQueue";

/** Job history remains inspectable after its last connection/view lease ends. */
export function ShellTransfers() {
  const open = useShellLayoutStore((s) => s.transfersOpen);
  const target = useShellLayoutStore((s) => s.transferTarget);
  const ref = useRef<HTMLDivElement>(null), t = useT();
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    if (target) ref.current?.querySelector(`[data-job-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest" });
    return () => { if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true }); };
  }, [open, target]);
  if (!open) return null;
  const close = () => useShellLayoutStore.setState({ transfersOpen: false });
  const act = (fn: (id: string) => Promise<void>, id: string) => { setError(null); void fn(id).catch((failure) => setError(String(failure))); };
  return <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} data-testid="shell-transfers" role="dialog" aria-modal="true" aria-label={t("shell.transfers")} className="w-[900px] max-w-full max-h-full overflow-auto border rounded p-3" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") {
          const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
          if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1)?.focus(); }
          else if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0]?.focus(); }
        }
      }}>
      <header className="flex items-center mb-2"><strong className="flex-1">{t("shell.transfers")}</strong><button data-testid="shell-transfers-close" onClick={close}>{t("common.close")}</button></header>
      {error && <p role="alert">{error}</p>}
      <FileTransferQueue forceOpen onCancel={(id) => act(sftpCancelTransfer, id)} onPause={(id) => act(sftpPauseTransfer, id)} onResume={(id) => act(sftpResumeTransfer, id)} />
    </div>
  </div>;
}

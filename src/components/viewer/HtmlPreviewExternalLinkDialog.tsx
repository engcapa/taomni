import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { useViewerLabels } from "./viewerLabels";
import "./viewer.css";

/** The page can forge bridge messages. Only this parent-owned action grants OS navigation. */
export function HtmlPreviewExternalLinkDialog({ href, onDecision }: {
  href: string; onDecision: (open: boolean) => void;
}) {
  const label = useViewerLabels();
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const decision = useRef(onDecision);
  decision.current = onDecision;
  useFocusReturn(true);
  useEffect(() => {
    cancelButton.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); decision.current(false); return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); event.stopImmediatePropagation();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);
  return createPortal(<div className="fv fv-global-dialog"><div className="fv-modal-bg">
    <div ref={dialog} className="fv-modal" role="dialog" aria-modal="true" aria-label={label("打开外部链接", "Open external link")} data-testid="html-external-dialog">
      <h3>{label("在系统浏览器中打开外部链接？", "Open this external link in your system browser?")}</h3>
      <p>{label("此请求来自本地预览页面，页面脚本也可能发起此请求。请确认目标地址。", "This request came from the local preview page and may have been initiated by a page script. Check the destination before opening.")}</p>
      <p><strong>{label("来源站点", "Destination origin")}</strong><br /><span data-testid="html-external-origin" dir="ltr">{new URL(href).origin}</span></p>
      <p data-testid="html-external-url" dir="ltr">{href}</p>
      <footer>
        <button ref={cancelButton} type="button" className="fv-button outline" data-testid="html-external-cancel" onClick={() => onDecision(false)}>{label("取消", "Cancel")}</button>
        <button type="button" className="fv-button primary" data-testid="html-external-open" onClick={() => onDecision(true)}><ExternalLink />{label("在浏览器中打开", "Open in browser")}</button>
      </footer>
    </div>
  </div></div>, document.body);
}

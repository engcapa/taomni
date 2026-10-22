import { type SetStateAction } from "react";
import { mailFetchRaw, mailSaveRaw, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { buildMailReaderSrcDoc } from "../../../lib/mailHtml";
import { formatMailPlainTextHtml } from "../../../lib/mailPlainText";
import { mailClientErrorMessage, addressLabel, bodyMatchesMessage, formatFullDate, escapeHtml } from "./messages";
import { suggestedAttachmentName } from "./attachments";


export interface CreateMessageExportActionsContext {
  selectedMessage: MailMessageHeader | null;
  body: MailMessageBody | null;
  mailFontSize: number;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  runMailAction: (action: () => Promise<void>, retry?: boolean) => Promise<void>;
  info: import("../../../types").MailTabInfo;
  setSourceView: import("react").Dispatch<SetStateAction<{ subject: string; content: string; } | null>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}

export function createMessageExportActions(context: CreateMessageExportActionsContext) {
  const { selectedMessage, body, mailFontSize, setError, runMailAction, info, setSourceView, setStatus } = context;

  const handlePrintMessage = (message = selectedMessage) => {
    if (!message) return;
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const headerHtml = `
      <div class="taomni-print-header" style="font-family:system-ui,sans-serif;padding:0 0 12px;margin:0 0 12px;border-bottom:1px solid #ccc;color:#111">
        <h2 style="margin:0 0 8px">${escapeHtml(message.subject || "(no subject)")}</h2>
        <div style="font-size:12px;color:#555;margin-bottom:4px">From: ${escapeHtml(addressLabel(message.from) || "(unknown)")}</div>
        <div style="font-size:12px;color:#555;margin-bottom:4px">To: ${escapeHtml(message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)")}</div>
        <div style="font-size:12px;color:#555">Date: ${escapeHtml(formatFullDate(message.dateTs) || "(unknown)")}</div>
      </div>`;
    const printHtml = currentBody?.html
      ? buildMailReaderSrcDoc(currentBody.html, {
        allowRemoteImages: true,
        fontSize: mailFontSize,
        preferDark: false,
      }).replace(
        /<body([^>]*)>/i,
        (_full, attrs: string) => `<body${attrs}>${headerHtml}`,
      )
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(message.subject || "Message")}</title>
<style>
.mail-quote{border-left:2px solid #729fcf;padding-left:.55em;margin:.1em 0}
.mail-quote-1{color:#1d4ed8}.mail-quote-2{color:#047857}.mail-quote-3{color:#6d28d9}
.mail-line{white-space:pre-wrap;min-height:1.35em}
</style>
</head><body style="font-family:system-ui,sans-serif;padding:24px;color:#111">${headerHtml}${formatMailPlainTextHtml(currentBody?.text ?? message.snippet ?? "")}</body></html>`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      setError("Unable to prepare the message for printing.");
      return;
    }
    doc.open();
    doc.write(printHtml);
    doc.close();
    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 500);
    };
    window.setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (e) {
        setError(mailClientErrorMessage(e));
      } finally {
        cleanup();
      }
    }, 150);
  };

  const handleViewSource = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const raw = await mailFetchRaw(info, message.folder, message.uid);
    setSourceView({ subject: message.subject || "(no subject)", content: raw });
  });

  const handleSaveEml = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = suggestedAttachmentName({ name: `${message.subject || "message"}.eml` }, 0, message.subject);
    const defaultPath = base.toLowerCase().endsWith(".eml") ? base : `${base}.eml`;
    const targetPath = await save({ title: "Save message as .eml", defaultPath });
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      setStatus("Save cancelled");
      return;
    }
    const result = await mailSaveRaw(info, message.folder, message.uid, targetPath);
    setStatus(`Saved message to ${result.path}`);
  });
  return { handleSaveEml, handleViewSource, handlePrintMessage };
}

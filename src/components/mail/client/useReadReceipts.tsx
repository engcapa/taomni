import { useEffect, useRef, useState, type SetStateAction } from "react";
import { MAIL_MDN_SENT, mailSendReceipt, mailSetFlags, type MailMessageHeader } from "../../../lib/mail";
import { mailClientErrorMessage, messageKey } from "./messages";

export interface UseReadReceiptsContext {
  selectedMessage: MailMessageHeader | null;
  info: import("../../../types").MailTabInfo;
  resolveSpecialFolder: (kind: import("./folders").SpecialFolderKind) => string | null;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  applyFlagsLocally: (folder: string, uids: number[], add: string[], remove: string[], unreadDelta: number) => void;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
}

export function useReadReceipts(context: UseReadReceiptsContext) {
  const { selectedMessage, info, resolveSpecialFolder, setStatus, applyFlagsLocally, setError } = context;
  /** Read receipt answered for these messages in this session (TASK-17). */
  const [receiptBusy, setReceiptBusy] = useState(false);
  const autoReceiptRef = useRef<Set<string>>(new Set());

  // TASK-17: "always" answers a read receipt request when the message is shown.
  const selectedReceiptKey = selectedMessage?.receiptTo ? messageKey(selectedMessage) : null;
  useEffect(() => {
    if (!selectedReceiptKey || !selectedMessage || (info.receiptPolicy ?? "ask") !== "always") return;
    if (autoReceiptRef.current.has(selectedReceiptKey) || !receiptRequest(selectedMessage)) return;
    autoReceiptRef.current.add(selectedReceiptKey);
    void answerReceipt(selectedMessage, true, true);
    // selectedMessage is identified by selectedReceiptKey.
  }, [selectedReceiptKey, info.receiptPolicy]);

  /** A pending read receipt request of `message` (not yet answered, not mine). */
  const receiptRequest = (message: MailMessageHeader | null | undefined): string | null => {
    if (!message?.receiptTo) return null;
    if (message.flags.some((flag) => flag.toLowerCase() === MAIL_MDN_SENT.toLowerCase())) return null;
    const own = [info.emailAddress, ...(info.identities ?? []).map((identity) => identity.email)]
      .map((address) => address?.trim().toLowerCase())
      .filter(Boolean);
    if (own.includes(message.from?.address?.trim().toLowerCase() ?? "")) return null;
    if (resolveSpecialFolder("sent") === message.folder) return null;
    return message.receiptTo;
  };

  const answerReceipt = async (message: MailMessageHeader, send: boolean, automatic = false) => {
    setReceiptBusy(true);
    try {
      if (send) {
        const result = await mailSendReceipt(info, message.folder, message.uid, automatic);
        setStatus(`Read receipt sent to ${result.sentTo}`);
      } else {
        await mailSetFlags(info, message.folder, [message.uid], [MAIL_MDN_SENT], []);
        setStatus("Read receipt declined");
      }
      applyFlagsLocally(message.folder, [message.uid], [MAIL_MDN_SENT], [], 0);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setReceiptBusy(false);
    }
  };

  const renderReceiptBanner = (message: MailMessageHeader) => {
    const address = receiptRequest(message);
    if (!address || (info.receiptPolicy ?? "ask") !== "ask") return null;
    return (
      <div
        className="mx-4 mt-3 px-3 py-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] flex flex-wrap items-center gap-2 text-[12px]"
        data-testid="mail-receipt-banner"
      >
        <span className="min-w-0 flex-1">The sender asked for a read receipt to {address}.</span>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-send" disabled={receiptBusy} onClick={() => void answerReceipt(message, true)}>
          Send receipt
        </button>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-ignore" disabled={receiptBusy} onClick={() => void answerReceipt(message, false)}>
          Ignore
        </button>
      </div>
    );
  };
  return { renderReceiptBanner };
}

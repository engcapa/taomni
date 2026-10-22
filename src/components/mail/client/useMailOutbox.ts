import { useCallback, useEffect, useRef, type SetStateAction } from "react";
import { isRecoveryStartup } from "../../../lib/runtimeRecovery";
import { mailDeleteDraft, mailListDrafts, mailSaveDraft, mailSendMessage, type MailDraft, type MailSendRequest, type MailSendResult } from "../../../lib/mail";
import { listen } from "@tauri-apps/api/event";
import { fromDateTimeLocal, isTransientSendError, outboxNextAttemptAt, outboxState, type MailOutboxState } from "../../../lib/mailOutbox";
import { mentionsAttachment } from "../../../lib/mailAttachReminder";
import { formatRecipientForSend, isValidEmailAddress, recipientLabel } from "../../../lib/mailRecipients";
import { hasRichMailFormatting, mailHtmlToPlainText, prepareMailHtmlForSend, sanitizeMailComposeHtml } from "../../../lib/mailHtml";
import { type ComposeDraft, type ComposePromptState } from "./types";
import { mailClientErrorMessage } from "./messages";
import { emptyComposeDraft, serializeDraftContent, draftContextWithIdentity, draftFromSaved, withoutOutbox, threadHeadersFor, identitySendFields } from "./compose";


export interface UseMailOutboxContext {
  identityById: (id: string | null | undefined) => import("../../../types").MailIdentity;
  setSentCopyNotice: import("react").Dispatch<SetStateAction<{ text: string; error: boolean; } | null>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  setDrafts: import("react").Dispatch<SetStateAction<MailDraft[]>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setComposeOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setSendLaterOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setComposePrompt: import("react").Dispatch<SetStateAction<ComposePromptState | null>>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
  outboxBusyIdsRef: import("react").RefObject<Set<string>>;
  undoSend: { draftId: string; until: number; } | null;
  composeOpen: boolean;
  draft: ComposeDraft;
  retryAfterTrustRef: import("react").RefObject<boolean>;
  syncFolderNow: (folder: string, indicator?: import("./types").SyncIndicator, notify?: boolean) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult | null>;
  selectedFolderRef: import("react").RefObject<string>;
  setUndoNow: import("react").Dispatch<SetStateAction<number>>;
  undoTimerRef: import("react").RefObject<number | null>;
  setUndoSend: import("react").Dispatch<SetStateAction<{ draftId: string; until: number; } | null>>;
  setSending: import("react").Dispatch<SetStateAction<boolean>>;
  sendLaterAt: string;
  drafts: MailDraft[];
  lastSavedDraftJsonRef: import("react").RefObject<string>;
}

export function useMailOutbox(context: UseMailOutboxContext) {
  const { identityById, setSentCopyNotice, setStatus, info, setDrafts, setError, setComposeOpen, setSendLaterOpen, setComposePrompt, setDraft, outboxBusyIdsRef, undoSend, composeOpen, draft, retryAfterTrustRef, syncFolderNow, selectedFolderRef, setUndoNow, undoTimerRef, setUndoSend, setSending, sendLaterAt, drafts, lastSavedDraftJsonRef } = context;

  /** MIME request for a composer draft, or an error to show. */
  const buildSendRequest = (source: ComposeDraft): MailSendRequest | string => {
    // Convert compose-time data-URL previews (data-taomni-cid) to cid: for MIME.
    const htmlBody = prepareMailHtmlForSend(source.htmlBody);
    const textBody = source.textBody.trim() || mailHtmlToPlainText(htmlBody);
    const sendHtml = source.richFormatUsed || hasRichMailFormatting(htmlBody);
    const recipients = [...source.to, ...source.cc, ...source.bcc];
    if (recipients.length === 0) return "At least one recipient is required.";
    const invalidRecipient = recipients.find((recipient) => !isValidEmailAddress(recipient.email));
    if (invalidRecipient) return `Invalid recipient: ${recipientLabel(invalidRecipient)}`;
    return {
      to: source.to.map(formatRecipientForSend),
      cc: source.cc.map(formatRecipientForSend),
      bcc: source.bcc.map(formatRecipientForSend),
      subject: source.subject.trim(),
      textBody,
      htmlBody: sendHtml ? htmlBody : null,
      attachments: source.attachments.map((attachment) => ({
        path: attachment.path,
        name: attachment.name ?? null,
        contentType: attachment.contentType ?? null,
        inline: attachment.inline ?? false,
        contentId: attachment.contentId ?? null,
      })),
      ...threadHeadersFor(source.replyContext),
      draftId: source.id ?? null,
      ...identitySendFields(identityById(source.identityId)),
      requestReadReceipt: source.readReceipt === true,
    };
  };

  const reportSentCopy = useCallback((folder?: string | null, error?: string | null) => {
    if (error) setSentCopyNotice({ text: `Message sent, but saving the Sent copy failed: ${error}`, error: true });
    else if (folder) setSentCopyNotice({ text: `Message sent; copy saved to ${folder}`, error: false });
  }, []);

  const sentStatus = (result: MailSendResult) => {
    if (!result.accepted) {
      setStatus(result.response || "SMTP send returned no acceptance");
    } else {
      setStatus("Message sent");
      reportSentCopy(result.sentCopyFolder, result.sentCopyError);
    }
  };

  // SMTP completes independently of the backend's Sent-copy task. Keep copy
  // failures visible without treating an accepted message as safe to resend.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ accountId: string; folder?: string | null; error?: string | null }>(
      "mail-sent-copy",
      ({ payload }) => {
        if (disposed || payload.accountId !== info.sessionId) return;
        // The event can precede the invoke response. A separate notice must
        // survive SMTP completion and unrelated mailbox refresh status.
        reportSentCopy(payload.folder, payload.error);
      },
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [info.sessionId, reportSentCopy]);

  /** Save a composer draft into the local Outbox (TASK-17). */
  const queueToOutbox = async (
    source: ComposeDraft,
    queue: Pick<MailOutboxState, "sendAt"> & Partial<MailOutboxState>,
  ): Promise<MailDraft | null> => {
    const outbox: MailOutboxState = {
      queuedAt: Math.floor(Date.now() / 1000),
      attempts: 0,
      lastError: null,
      readReceipt: source.readReceipt === true,
      ...queue,
    };
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: source.id ?? null,
        to: source.to.map(formatRecipientForSend),
        cc: source.cc.map(formatRecipientForSend),
        bcc: source.bcc.map(formatRecipientForSend),
        subject: source.subject,
        textBody: source.textBody || mailHtmlToPlainText(source.htmlBody),
        htmlBody: sanitizeMailComposeHtml(source.htmlBody),
        attachments: source.attachments,
        replyContext: { ...(draftContextWithIdentity(source) ?? {}), outbox },
      });
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      return saved;
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    }
  };

  const closeComposer = () => {
    setComposeOpen(false);
    setSendLaterOpen(false);
    setComposePrompt(null);
    setDraft(emptyComposeDraft());
  };

  const showComposeError = (message: string) => {
    setError(null);
    setStatus(null);
    setComposePrompt({ kind: "error", title: "Cannot send message", message });
  };

  /** Send one queued message; failures stay queued with a retry backoff. */
  const sendOutboxItem = async (saved: MailDraft, manual = false): Promise<boolean> => {
    const state = outboxState(saved);
    if (!state || outboxBusyIdsRef.current.has(saved.id)) return false;
    const built = buildSendRequest(draftFromSaved(saved));
    if (typeof built === "string") {
      if (manual) showComposeError(built);
      return false;
    }
    outboxBusyIdsRef.current.add(saved.id);
    setSentCopyNotice(null);
    try {
      const result = await mailSendMessage(info, { ...built, draftId: saved.id });
      await mailDeleteDraft(info.sessionId, saved.id).catch(() => undefined);
      setDrafts((current) => current.filter((item) => item.id !== saved.id));
      sentStatus(result);
      return true;
    } catch (e) {
      const message = mailClientErrorMessage(e);
      const next: MailOutboxState = { ...state, attempts: state.attempts + 1, lastError: message };
      try {
        const updated = await mailSaveDraft(info.sessionId, {
          id: saved.id,
          to: saved.to,
          cc: saved.cc,
          bcc: saved.bcc,
          subject: saved.subject,
          textBody: saved.textBody,
          htmlBody: saved.htmlBody,
          attachments: saved.attachments,
          replyContext: { ...(saved.replyContext ?? {}), outbox: next },
        });
        setDrafts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } catch (saveError) {
        console.debug("mail: outbox retry state not saved", saveError);
      }
      if (manual) setError(`Sending "${saved.subject || "(no subject)"}" failed: ${message}`);
      return false;
    } finally {
      outboxBusyIdsRef.current.delete(saved.id);
    }
  };

  /** Send every due (or, when `all`, every) queued message. */
  const processOutbox = async (all = false) => {
    let list: MailDraft[];
    try {
      list = await mailListDrafts(info.sessionId);
    } catch (e) {
      console.debug("mail: outbox list failed", e);
      return;
    }
    setDrafts(list);
    const now = Math.floor(Date.now() / 1000);
    const pendingUndo = undoSendRef.current?.draftId;
    const editing = composeDraftIdRef.current;
    const due = list.filter((saved) => {
      const state = outboxState(saved);
      // Skip the undo-window message and one reopened in the composer.
      if (!state || saved.id === pendingUndo || saved.id === editing) return false;
      if (all) return true;
      const at = outboxNextAttemptAt(state);
      return at != null && at <= now;
    });
    let sent = 0;
    for (const saved of due) {
      if (await sendOutboxItem(saved, all)) sent += 1;
    }
    if (all && due.length > 0) {
      setStatus(sent === due.length ? `Sent ${sent} queued message${sent === 1 ? "" : "s"}` : `Sent ${sent} of ${due.length} queued messages`);
    }
  };
  const processOutboxRef = useRef(processOutbox);
  processOutboxRef.current = processOutbox;
  const undoSendRef = useRef(undoSend);
  undoSendRef.current = undoSend;
  const composeDraftIdRef = useRef<string | null>(null);
  composeDraftIdRef.current = composeOpen ? draft.id ?? null : null;

  useEffect(() => {
    if (!retryAfterTrustRef.current) return;
    retryAfterTrustRef.current = false;
    void syncFolderNow(selectedFolderRef.current, "sync", true);
  }, [info.imap.trustedCert, info.smtp.trustedCert]);

  // Recovery never automatically resends an operation with unknown outcome.
  useEffect(() => {
    if (isRecoveryStartup()) return;
    const first = window.setTimeout(() => void processOutboxRef.current(), 3000);
    const id = window.setInterval(() => void processOutboxRef.current(), 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [info.sessionId]);

  useEffect(() => {
    if (!undoSend) return;
    const id = window.setInterval(() => setUndoNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [undoSend]);

  // A pending undo survives unmount in the Outbox and goes out on next open.
  useEffect(() => () => {
    if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
  }, []);

  const handleSendDraft = async (skipAttachReminder = false) => {
    const built = buildSendRequest(draft);
    if (typeof built === "string") {
      showComposeError(built);
      return;
    }
    // Thunderbird's attachment reminder: text mentions one, none attached.
    if (!skipAttachReminder && draft.attachments.length === 0
      && mentionsAttachment(draft.subject, draft.textBody, draft.htmlBody)) {
      setError(null);
      setStatus(null);
      setComposePrompt({
        kind: "attachment",
        title: "Attachment missing",
        message: "The message mentions an attachment, but no file is attached. Add an attachment or send anyway.",
      });
      return;
    }
    setComposePrompt(null);
    setError(null);
    const undoSeconds = Math.max(0, Math.floor(info.undoSendSeconds ?? 0));
    if (undoSeconds > 0) {
      // Undo window: the message waits in the Outbox until the timer fires.
      const until = Math.floor(Date.now() / 1000) + undoSeconds;
      const queued = await queueToOutbox(draft, { sendAt: until });
      if (!queued) return;
      closeComposer();
      setUndoSend({ draftId: queued.id, until });
      setUndoNow(Date.now());
      if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => {
        undoTimerRef.current = null;
        setUndoSend(null);
        void sendOutboxItem(queued, true);
      }, undoSeconds * 1000);
      return;
    }
    setSending(true);
    setSentCopyNotice(null);
    try {
      const result = await mailSendMessage(info, built);
      sentStatus(result);
      closeComposer();
      if (draft.id) {
        void mailDeleteDraft(info.sessionId, draft.id).catch(() => undefined);
        setDrafts((current) => current.filter((item) => item.id !== draft.id));
      }
    } catch (e) {
      const message = mailClientErrorMessage(e);
      // Offline / unreachable server: keep the message in the Outbox (AC-49).
      if (isTransientSendError(message)) {
        const now = Math.floor(Date.now() / 1000);
        const queued = await queueToOutbox(draft, { sendAt: now, attempts: 1, lastError: message });
        if (queued) {
          closeComposer();
          setStatus("Could not reach the mail server; the message is in the Outbox and retries while this tab is open");
          return;
        }
      }
      setError(message);
    } finally {
      setSending(false);
    }
  };

  const handleSendLater = async () => {
    const built = buildSendRequest(draft);
    if (typeof built === "string") {
      showComposeError(built);
      return;
    }
    const at = fromDateTimeLocal(sendLaterAt);
    const queued = await queueToOutbox(draft, { sendAt: at });
    if (!queued) return;
    closeComposer();
    setStatus(at
      ? `Scheduled for ${new Date(at * 1000).toLocaleString()} (sends while this tab is open)`
      : "Saved to Outbox; use Send now in Drafts > Outbox");
  };

  const handleUndoSend = async () => {
    const pending = undoSend;
    if (!pending) return;
    if (undoTimerRef.current != null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoSend(null);
    const saved = drafts.find((item) => item.id === pending.draftId)
      ?? (await mailListDrafts(info.sessionId).catch(() => [] as MailDraft[])).find((item) => item.id === pending.draftId);
    if (!saved) return;
    const restored = draftFromSaved(saved);
    // Back to a plain draft, then reopen it for editing.
    await mailSaveDraft(info.sessionId, {
      id: saved.id,
      to: saved.to,
      cc: saved.cc,
      bcc: saved.bcc,
      subject: saved.subject,
      textBody: saved.textBody,
      htmlBody: saved.htmlBody,
      attachments: saved.attachments,
      replyContext: withoutOutbox(saved.replyContext),
    }).then((plain) => setDrafts((current) => current.map((item) => (item.id === plain.id ? plain : item))))
      .catch((e) => console.debug("mail: undo could not clear outbox state", e));
    setDraft(restored);
    lastSavedDraftJsonRef.current = serializeDraftContent(restored);
    setComposeOpen(true);
    setStatus("Sending cancelled");
  };
  return { handleSendDraft, handleUndoSend, processOutbox, sendOutboxItem, handleSendLater };
}

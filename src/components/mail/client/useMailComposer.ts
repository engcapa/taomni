import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { mailDeleteDraft, type MailDraft, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { buildForwardHtml, buildReplyHtml, plainTextToMailHtml, quotePlainText } from "../../../lib/mailHtml";
import { mailIdentities, ownIdentityAddresses, pickReplyIdentity } from "../../../lib/mailIdentities";
import { isOutbox } from "../../../lib/mailOutbox";
import { extractDefaultMailDomain, parseRecipientsText } from "../../../lib/mailRecipients";
import { parseMailto } from "../../../lib/mailto";
import {
  EMPTY_DRAFT,
  appendUniqueAddress,
  draftHasContent,
  emptyComposeDraft,
  forwardSubject,
  isTemplate,
  normalizedMailAddress,
  replyContextFor,
  serializeDraftContent,
} from "./compose";
import { createDraftActions } from "./draftActions";
import { addressLabel, bodyMatchesMessage, formatFullDate, mailClientErrorMessage } from "./messages";
import { type ComposeDraft, type ComposePromptState } from "./types";
import { useComposerAttachments } from "./useComposerAttachments";
import { useMailOutbox } from "./useMailOutbox";
import { useRecipientSuggestions } from "./useRecipientSuggestions";

export interface UseMailComposerContext {
  info: import("../../../types").MailTabInfo;
  messages: MailMessageHeader[];
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  selectedMessage: MailMessageHeader | null;
  body: MailMessageBody | null;
  retryAfterTrustRef: import("react").RefObject<boolean>;
  syncFolderNow: (folder: string, indicator?: import("./types").SyncIndicator, notify?: boolean) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult | null>;
  selectedFolderRef: import("react").RefObject<string>;
}

export function useMailComposer(context: UseMailComposerContext) {
  const { info, messages, setError, setStatus, selectedMessage, body, retryAfterTrustRef, syncFolderNow, selectedFolderRef } = context;
  const [sentCopyNotice, setSentCopyNotice] = useState<{ text: string; error: boolean; } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftsTab, setDraftsTab] = useState<"drafts" | "templates" | "outbox">("drafts");
  const visibleDrafts = useMemo(
    () => drafts.filter((saved) => {
      if (draftsTab === "outbox") return isOutbox(saved);
      if (isOutbox(saved)) return false;
      return isTemplate(saved) === (draftsTab === "templates");
    }),
    [drafts, draftsTab],
  );
  const outboxCount = useMemo(() => drafts.filter(isOutbox).length, [drafts]);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [composePrompt, setComposePrompt] = useState<ComposePromptState | null>(null);
  const [sendLaterAt, setSendLaterAt] = useState("");
  const [undoSend, setUndoSend] = useState<{ draftId: string; until: number; } | null>(null);
  const [undoNow, setUndoNow] = useState(() => Date.now());
  const undoTimerRef = useRef<number | null>(null);
  const outboxBusyIdsRef = useRef(new Set<string>());
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [composeDragActive, setComposeDragActive] = useState(false);
  const [attachProgress, setAttachProgress] = useState<{ done: number; total: number; label: string; } | null>(null);
  const composeRootRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastSavedDraftJsonRef = useRef("");
  const identities = useMemo(() => mailIdentities(info), [info]);
  const identityById = useCallback(
    (id: string | null | undefined) => identities.find((identity) => identity.id === id) ?? identities[0],
    [identities],
  );
  const defaultMailDomain = useMemo(
    () => extractDefaultMailDomain([info.emailAddress, info.imap.username, info.smtp.username]),
    [info.emailAddress, info.imap.username, info.smtp.username],
  );
  const { setRecipientSearch, recipientSuggestionsFor, recipientSearch, handleRecipientQueryChange } = useRecipientSuggestions({
    draft,
    messages,
    composeOpen,
    info,
  });
  const { fallbackBodyFor, openCompose, saveCurrentDraft, refreshDrafts, openFromTemplate, openSavedDraft, deleteSavedDraft, saveCurrentAsTemplate } = createDraftActions({
    setDraftsLoading,
    setDrafts,
    info,
    setError,
    identityById,
    setDraft,
    setComposePrompt,
    lastSavedDraftJsonRef,
    setRecipientSearch,
    setComposeOpen,
    draft,
    setSavingDraft,
    setStatus,
    setDraftsOpen,
  });

  const replyDraftBody = (target: MailMessageHeader, currentBody: MailMessageBody, signature: string | null | undefined) => {
    const intro = `On ${formatFullDate(target.dateTs) || "an unknown date"}, ${addressLabel(target.from) || "(unknown sender)"} wrote:`;
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildReplyHtml(intro, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}${intro}\n${quotePlainText(originalText)}`,
    };
  };

  const openReply = (target = selectedMessage) => {
    if (!target) return;
    const from = target.from?.address ?? addressLabel(target.from);
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(from),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("reply", target),
      richFormatUsed: true,
    }, false);
  };

  const openReplyAll = (target = selectedMessage) => {
    if (!target) return;
    const ownAddresses = new Set([
      normalizedMailAddress(info.emailAddress),
      normalizedMailAddress(info.imap.username),
      normalizedMailAddress(info.smtp.username),
      ...ownIdentityAddresses(identities),
    ].filter(Boolean));
    const to: string[] = [];
    const cc: string[] = [];
    const seenTo = new Set<string>();
    const seenCc = new Set<string>();
    appendUniqueAddress(to, seenTo, target.from, ownAddresses);
    for (const recipient of target.to) appendUniqueAddress(to, seenTo, recipient, ownAddresses);
    for (const recipient of target.cc) {
      const mail = normalizedMailAddress(recipient.address ?? addressLabel(recipient));
      if (seenTo.has(mail)) continue;
      appendUniqueAddress(cc, seenCc, recipient, ownAddresses);
    }
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(to.join(", ")),
      cc: parseRecipientsText(cc.join(", ")),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("replyAll", target),
      richFormatUsed: true,
    }, false);
  };
  const { handleSendDraft, handleUndoSend, processOutbox, sendOutboxItem, handleSendLater } = useMailOutbox({
    identityById,
    setSentCopyNotice,
    setStatus,
    info,
    setDrafts,
    setError,
    setComposeOpen,
    setSendLaterOpen,
    setComposePrompt,
    setDraft,
    outboxBusyIdsRef,
    undoSend,
    composeOpen,
    draft,
    retryAfterTrustRef,
    syncFolderNow,
    selectedFolderRef,
    setUndoNow,
    undoTimerRef,
    setUndoSend,
    setSending,
    sendLaterAt,
    drafts,
    lastSavedDraftJsonRef,
  });
  const {
    handleAddDraftAttachments,
    addDraftAttachmentPaths,
    handleDropComposeFiles,
    handleInsertInlineImage,
    handlePasteImages,
    removeDraftAttachment,
  } = useComposerAttachments({
    setAttachProgress,
    setDraft,
    setStatus,
    setError,
    composeOpen,
    setComposeDragActive,
    sending,
    composeRootRef,
  });

  const discardCurrentDraft = async () => {
    const draftId = draft.id;
    setComposeOpen(false);
    setComposePrompt(null);
    setDraft(emptyComposeDraft());
    lastSavedDraftJsonRef.current = "";
    if (!draftId) return;
    try {
      await mailDeleteDraft(info.sessionId, draftId);
      setDrafts((current) => current.filter((item) => item.id !== draftId));
      setStatus("Draft discarded");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  useEffect(() => {
    if (!composeOpen || sending || savingDraft || !draftHasContent(draft)) return;
    const serialized = serializeDraftContent(draft);
    if (serialized === lastSavedDraftJsonRef.current) return;
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft("auto");
    }, 1800);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [composeOpen, draft, savingDraft, sending]);

  const buildForwardBody = (
    target: MailMessageHeader,
    signature: string | null | undefined = info.signature,
  ): { htmlBody: string; textBody: string; } => {
    const currentBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const headerLines = [
      `From: ${addressLabel(target.from) || "(unknown sender)"}`,
      target.dateTs ? `Date: ${formatFullDate(target.dateTs)}` : "",
      `Subject: ${target.subject || "(no subject)"}`,
      `To: ${target.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}`,
    ].filter(Boolean);
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildForwardHtml(headerLines, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}---------- Forwarded message ----------\n${headerLines.join("\n")}\n\n${originalText}`,
    };
  };

  const openForward = (target = selectedMessage) => {
    if (!target) return;
    const identity = pickReplyIdentity(identities, target);
    const forwardBody = buildForwardBody(target, identity.signature);
    openCompose({
      identityId: identity.id,
      subject: forwardSubject(target.subject),
      htmlBody: forwardBody.htmlBody,
      textBody: forwardBody.textBody,
      replyContext: replyContextFor("forward", target),
      richFormatUsed: true,
    }, false);
  };

  /** In-app composer for `mailto:` links (reader links, List-Unsubscribe). */
  const openComposeFromMailto = (href: string) => {
    const fields = parseMailto(href);
    if (!fields) return;
    const body = fields.body.trim();
    openCompose({
      to: parseRecipientsText(fields.to.join(", ")),
      cc: parseRecipientsText(fields.cc.join(", ")),
      bcc: parseRecipientsText(fields.bcc.join(", ")),
      subject: fields.subject,
      ...(body ? { textBody: fields.body, htmlBody: plainTextToMailHtml(fields.body) } : {}),
    }, !body);
  };
  return { openComposeFromMailto, openReply, openReplyAll, openForward, composeOpen, draftsOpen, openCompose, setDraftsOpen, refreshDrafts, outboxCount, sentCopyNotice, setSentCopyNotice, composePrompt, setComposePrompt, handleAddDraftAttachments, handleSendDraft, undoSend, undoNow, handleUndoSend, draftsTab, draftsLoading, setDraftsTab, visibleDrafts, processOutbox, openFromTemplate, openSavedDraft, sendOutboxItem, deleteSavedDraft, composeRootRef, sending, setComposeDragActive, addDraftAttachmentPaths, handleDropComposeFiles, draft, setComposeOpen, saveCurrentDraft, savingDraft, setDraft, attachProgress, identityById, identities, recipientSuggestionsFor, defaultMailDomain, recipientSearch, handleRecipientQueryChange, composeDragActive, handleInsertInlineImage, handlePasteImages, removeDraftAttachment, saveCurrentAsTemplate, discardCurrentDraft, setSendLaterAt, setSendLaterOpen, sendLaterOpen, sendLaterAt, handleSendLater };
}

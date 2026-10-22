import { type SetStateAction } from "react";
import { mailDeleteDraft, mailDiscardRemoteDraft, mailStoreRemoteDraft, mailListDrafts, mailSaveDraft, type MailDraft, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { isOutbox } from "../../../lib/mailOutbox";
import { formatRecipientForSend } from "../../../lib/mailRecipients";
import { mailHtmlToPlainText, sanitizeMailComposeHtml } from "../../../lib/mailHtml";
import { type ComposeDraft, type ComposePromptState, type RecipientSearchState } from "./types";
import { mailClientErrorMessage } from "./messages";
import { draftWithSignature, emptyComposeDraft, serializeDraftContent, draftHasContent, draftContextWithIdentity, TEMPLATE_KIND, draftFromSaved, withoutOutbox } from "./compose";


export interface CreateDraftActionsContext {
  setDraftsLoading: import("react").Dispatch<SetStateAction<boolean>>;
  setDrafts: import("react").Dispatch<SetStateAction<MailDraft[]>>;
  info: import("../../../types").MailTabInfo;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  identityById: (id: string | null | undefined) => import("../../../types").MailIdentity;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
  setComposePrompt: import("react").Dispatch<SetStateAction<ComposePromptState | null>>;
  lastSavedDraftJsonRef: import("react").RefObject<string>;
  setRecipientSearch: import("react").Dispatch<SetStateAction<RecipientSearchState>>;
  setComposeOpen: import("react").Dispatch<SetStateAction<boolean>>;
  draft: ComposeDraft;
  setSavingDraft: import("react").Dispatch<SetStateAction<boolean>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setDraftsOpen: import("react").Dispatch<SetStateAction<boolean>>;
}

export function createDraftActions(context: CreateDraftActionsContext) {
  const { setDraftsLoading, setDrafts, info, setError, identityById, setDraft, setComposePrompt, lastSavedDraftJsonRef, setRecipientSearch, setComposeOpen, draft, setSavingDraft, setStatus, setDraftsOpen } = context;

  const refreshDrafts = async () => {
    setDraftsLoading(true);
    try {
      setDrafts(await mailListDrafts(info.sessionId));
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDraftsLoading(false);
    }
  };

  const openCompose = (nextDraft: Partial<ComposeDraft> = {}, includeSignature = true) => {
    const identity = identityById(nextDraft.identityId);
    const withIdentity = { ...nextDraft, identityId: identity.id };
    const next = includeSignature ? draftWithSignature(withIdentity, identity.signature) : { ...emptyComposeDraft(), ...withIdentity };
    setDraft(next);
    setComposePrompt(null);
    lastSavedDraftJsonRef.current = serializeDraftContent(next);
    setRecipientSearch({ field: null, query: "", suggestions: [], loading: false });
    setComposeOpen(true);
  };

  const saveCurrentDraft = async (mode: "manual" | "auto" = "manual") => {
    if (!draftHasContent(draft)) return null;
    const serialized = serializeDraftContent(draft);
    if (mode === "auto" && serialized === lastSavedDraftJsonRef.current) return null;
    setSavingDraft(true);
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: draft.id ?? null,
        to: draft.to.map(formatRecipientForSend),
        cc: draft.cc.map(formatRecipientForSend),
        bcc: draft.bcc.map(formatRecipientForSend),
        subject: draft.subject,
        textBody: draft.textBody || mailHtmlToPlainText(draft.htmlBody),
        htmlBody: sanitizeMailComposeHtml(draft.htmlBody),
        attachments: draft.attachments,
        replyContext: draftContextWithIdentity(draft),
      });
      lastSavedDraftJsonRef.current = serialized;
      setDraft((current) => ({ ...current, id: saved.id }));
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      if (mode === "manual") {
        setStatus("Draft saved");
        // Mirror explicit saves to the server Drafts folder (autosave stays local).
        void mailStoreRemoteDraft(info, saved.id)
          .then((stored) => {
            setDrafts((current) => current.map((item) => (item.id === stored.id ? stored : item)));
            if (stored.remoteDraftFolder) setStatus(`Draft saved to ${stored.remoteDraftFolder}`);
          })
          .catch((e) => setStatus(`Draft saved locally; server copy failed: ${mailClientErrorMessage(e)}`));
      }
      return saved;
    } catch (e) {
      if (mode === "manual") setError(mailClientErrorMessage(e));
      return null;
    } finally {
      setSavingDraft(false);
    }
  };

  /** Templates are local drafts tagged kind "template"; each save adds one. */
  const saveCurrentAsTemplate = async () => {
    if (!draftHasContent(draft)) return;
    setSavingDraft(true);
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: null,
        to: draft.to.map(formatRecipientForSend),
        cc: draft.cc.map(formatRecipientForSend),
        bcc: draft.bcc.map(formatRecipientForSend),
        subject: draft.subject,
        textBody: draft.textBody || mailHtmlToPlainText(draft.htmlBody),
        htmlBody: sanitizeMailComposeHtml(draft.htmlBody),
        attachments: draft.attachments,
        replyContext: { kind: TEMPLATE_KIND, identityId: draftContextWithIdentity(draft)?.identityId ?? null },
      });
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setStatus("Template saved");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setSavingDraft(false);
    }
  };

  const openFromTemplate = (template: MailDraft) => {
    const next = draftFromSaved(template);
    openCompose({
      ...next,
      id: null,
      replyContext: null,
      identityId: template.replyContext?.identityId ?? null,
    }, false);
    setDraftsOpen(false);
  };

  const openSavedDraft = (saved: MailDraft) => {
    const next = draftFromSaved(saved);
    if (isOutbox(saved)) {
      // Editing a queued message takes it out of the Outbox (Thunderbird).
      void mailSaveDraft(info.sessionId, {
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
        .catch((e) => console.debug("mail: could not move draft out of the Outbox", e));
    }
    setDraft(next);
    lastSavedDraftJsonRef.current = serializeDraftContent(next);
    setRecipientSearch({ field: null, query: "", suggestions: [], loading: false });
    setDraftsOpen(false);
    setComposeOpen(true);
  };

  const deleteSavedDraft = async (saved: MailDraft) => {
    try {
      if (saved.remoteDraftUid) {
        await mailDiscardRemoteDraft(info, saved.id).catch((e) => {
          console.debug("mail: discarding server draft failed", e);
        });
      }
      await mailDeleteDraft(info.sessionId, saved.id);
      setDrafts((current) => current.filter((item) => item.id !== saved.id));
      if (draft.id === saved.id) setDraft(emptyComposeDraft());
      setStatus("Draft deleted");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const fallbackBodyFor = (target: MailMessageHeader): MailMessageBody => ({
    accountId: target.accountId,
    folder: target.folder,
    uid: target.uid,
    messageId: target.messageId,
    subject: target.subject,
    text: target.snippet ?? "",
    html: null,
    snippet: target.snippet,
    attachments: [],
    rawSize: target.rawSize,
    cachedAt: null,
    source: "header",
  });
  return { fallbackBodyFor, openCompose, saveCurrentDraft, refreshDrafts, openFromTemplate, openSavedDraft, deleteSavedDraft, saveCurrentAsTemplate };
}

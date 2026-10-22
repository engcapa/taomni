import type { MailIdentity } from "../../../types";
import { type MailAddress, type MailDraft, type MailDraftContext, type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";
import { outboxState } from "../../../lib/mailOutbox";
import { DEFAULT_IDENTITY_ID, identityFromHeader } from "../../../lib/mailIdentities";
import { formatRecipientForSend, parseRecipientsText } from "../../../lib/mailRecipients";
import { hasRichMailFormatting, mailHtmlToPlainText, plainTextToMailHtml, signatureToMailHtml } from "../../../lib/mailHtml";
import { type ComposeDraft } from "./types";
import { addressLabel } from "./messages";


export function emptyComposeDraft(): ComposeDraft {
  return {
    id: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    htmlBody: "<p><br></p>",
    textBody: "",
    attachments: [],
    replyContext: null,
    richFormatUsed: false,
  };
}


export const EMPTY_DRAFT: ComposeDraft = {
  id: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  htmlBody: "<p><br></p>",
  textBody: "",
  attachments: [],
  replyContext: null,
  richFormatUsed: false,
};


export function replyContextFor(
  kind: "reply" | "replyAll" | "forward",
  target: MailMessageHeader,
): MailDraftContext {
  const references = [...(target.references ?? [])];
  if (target.inReplyTo && !references.includes(target.inReplyTo)) references.push(target.inReplyTo);
  return {
    kind,
    folder: target.folder,
    uid: target.uid,
    messageId: target.messageId,
    subject: target.subject,
    references,
  };
}


/** In-Reply-To / References for a reply; forwards start a new thread. */
export function threadHeadersFor(context: MailDraftContext | null | undefined): { inReplyTo: string | null; references: string[] } {
  if (!context || context.kind === "forward" || !context.messageId) return { inReplyTo: null, references: [] };
  return { inReplyTo: context.messageId, references: context.references ?? [] };
}


export function decodeFolderLabel(name: string, folders: readonly MailFolder[]): string {
  const folder = folders.find((entry) => entry.name === name);
  return folder ? folderLabel(folder) : name;
}


export const TEMPLATE_KIND = "template";


export function isTemplate(saved: MailDraft): boolean {
  return saved.replyContext?.kind === TEMPLATE_KIND;
}


export function draftContextWithIdentity(draft: ComposeDraft): MailDraftContext | null {
  const identityId = draft.identityId && draft.identityId !== DEFAULT_IDENTITY_ID ? draft.identityId : null;
  if (!draft.replyContext && !identityId) return null;
  return { ...(draft.replyContext ?? {}), identityId };
}


export function identitySendFields(identity: MailIdentity): { from: string | null; replyTo: string | null } {
  if (identity.id === DEFAULT_IDENTITY_ID) return { from: null, replyTo: null };
  return { from: identityFromHeader(identity), replyTo: identity.replyTo ?? null };
}


export function draftWithSignature(draft: Partial<ComposeDraft>, signature: string | null | undefined): ComposeDraft {
  const base = { ...emptyComposeDraft(), ...draft };
  if (!signature?.trim()) return base;
  const signatureHtml = signatureToMailHtml(signature);
  const signatureText = `\n\n-- \n${signature.trimEnd()}`;
  const htmlBody = base.htmlBody?.trim() && base.htmlBody !== "<p><br></p>"
    ? base.htmlBody
    : `<p><br></p>${signatureHtml}`;
  const textBody = base.textBody?.trim() ? base.textBody : signatureText.trimStart();
  return { ...base, htmlBody, textBody };
}


export function draftHasContent(draft: ComposeDraft): boolean {
  return !!(
    draft.to.length ||
    draft.cc.length ||
    draft.bcc.length ||
    draft.subject.trim() ||
    draft.textBody.trim() ||
    mailHtmlToPlainText(draft.htmlBody).trim() ||
    draft.attachments.length
  );
}


export function serializeDraftContent(draft: ComposeDraft): string {
  return JSON.stringify({
    to: draft.to.map(formatRecipientForSend),
    cc: draft.cc.map(formatRecipientForSend),
    bcc: draft.bcc.map(formatRecipientForSend),
    subject: draft.subject,
    textBody: draft.textBody,
    htmlBody: draft.htmlBody,
    attachments: draft.attachments,
    replyContext: draft.replyContext ?? null,
  });
}


/** Reply context without the Outbox queue state (editing leaves the Outbox). */
export function withoutOutbox(context: MailDraftContext | null | undefined): MailDraftContext | null {
  if (!context) return null;
  const { outbox: _outbox, ...rest } = context;
  return rest;
}


export function draftFromSaved(saved: MailDraft): ComposeDraft {
  return {
    readReceipt: outboxState(saved)?.readReceipt ?? false,
    id: saved.id,
    to: parseRecipientsText(saved.to.join(", ")),
    cc: parseRecipientsText(saved.cc.join(", ")),
    bcc: parseRecipientsText(saved.bcc.join(", ")),
    subject: saved.subject,
    htmlBody: saved.htmlBody || plainTextToMailHtml(saved.textBody),
    textBody: saved.textBody,
    attachments: saved.attachments ?? [],
    replyContext: withoutOutbox(saved.replyContext),
    richFormatUsed: hasRichMailFormatting(saved.htmlBody),
    identityId: saved.replyContext?.identityId ?? null,
  };
}


export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed || "(no subject)"}`;
}


export function normalizedMailAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}


export function appendUniqueAddress(target: string[], seen: Set<string>, address: MailAddress | null | undefined, ownAddresses: Set<string>) {
  const label = addressLabel(address);
  const mail = normalizedMailAddress(address?.address ?? label);
  if (!label || !mail || ownAddresses.has(mail) || seen.has(mail)) return;
  seen.add(mail);
  target.push(label);
}

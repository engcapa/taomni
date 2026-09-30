/**
 * Thunderbird-style attachment reminder (TASK-15): the message text mentions
 * an attachment but none is attached. Quoted text (replies/forwards) is
 * ignored so "see the attached file" in the original does not trigger it.
 */
const ATTACHMENT_WORDS =
  /\b(attach(ed|es|ing|ment|ments)?|enclosed|see (the )?file)\b|附件|附上|见附|請見附|附檔|添付/i;

function stripQuotedHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ");
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("blockquote, .moz-cite-prefix, [data-taomni-quote]").forEach((node) => node.remove());
  return doc.body.textContent ?? "";
}

/** Own text of the draft: HTML without blockquotes, plain text without `>` lines. */
export function ownMessageText(textBody: string, htmlBody: string): string {
  if (htmlBody.trim()) return stripQuotedHtml(htmlBody);
  return textBody
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

export function mentionsAttachment(subject: string, textBody: string, htmlBody: string): boolean {
  return ATTACHMENT_WORDS.test(subject) || ATTACHMENT_WORDS.test(ownMessageText(textBody, htmlBody));
}

export { preprocessMailHtml, isRemoteMailImageSrc, mailHtmlHasRemoteImages, sanitizeMailComposeHtml } from "./mailHtml/sanitize";

export {
  extractMailDocumentChrome,
  extractMailStyleBlocks,
  sanitizeMailStylesheet,
  prepareMailDisplayDocument,
  buildMailReaderBaseCss,
  MAIL_READER_BASE_CSS,
  buildMailReaderSrcDoc,
  sanitizeMailDisplayHtml,
} from "./mailHtml/document";

export { type MailDisplayDocument, type MailReaderRenderOptions } from "./mailHtml/types";

export {
  markdownToMailHtml,
  buildInlineImageHtml,
  prepareMailHtmlForSend,
  plainTextToMailHtml,
  mailHtmlToPlainText,
  hasRichMailFormatting,
  signatureToMailHtml,
  buildReplyHtml,
  buildForwardHtml,
  quotePlainText,
} from "./mailHtml/compose";

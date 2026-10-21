export interface MailDisplayDocument {
  /** Sanitized body fragment (no surrounding html/body). */
  bodyHtml: string;
  /** Sanitized CSS from original <style> blocks. */
  styles: string;
  /** Safe presentation for the document body element. */
  bodyStyle: string;
}

export interface MailReaderRenderOptions {
  allowRemoteImages: boolean;
  /** Reader font size in px (from mail appearance). */
  fontSize?: number;
  /** Prefer dark paper defaults when the message has no own background. */
  preferDark?: boolean;
  /** Optional CSS font-family for body defaults. */
  fontFamily?: string;
}

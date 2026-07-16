import { useEffect, useMemo, useRef, useState } from "react";
import { buildMailReaderSrcDoc } from "../../lib/mailHtml";

interface MailHtmlReaderProps {
  html: string;
  allowRemoteImages: boolean;
  /** Accessible name for the iframe. */
  title?: string;
  className?: string;
  /** Prefer dark paper when message has no own background. */
  preferDark?: boolean;
  /** Appearance font size (px). */
  fontSize?: number;
  fontFamily?: string;
}

/**
 * Thunderbird-style HTML mail surface: sandboxed iframe with its own document,
 * base paper chrome, sanitized <style> blocks, and auto height.
 */
export function MailHtmlReader({
  html,
  allowRemoteImages,
  title = "Message body",
  className,
  preferDark = false,
  fontSize = 14,
  fontFamily,
}: MailHtmlReaderProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(160);
  const srcDoc = useMemo(
    () => buildMailReaderSrcDoc(html, {
      allowRemoteImages,
      preferDark,
      fontSize,
      fontFamily,
    }),
    [allowRemoteImages, fontFamily, fontSize, html, preferDark],
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const doc = iframe.contentDocument;
      if (!doc) return;
      const body = doc.body;
      const root = doc.documentElement;
      if (!body || !root) return;
      const height = Math.ceil(
        Math.max(
          body.scrollHeight,
          body.offsetHeight,
          root.scrollHeight,
          root.offsetHeight,
          120,
        ),
      );
      setFrameHeight((prev) => (Math.abs(prev - height) > 1 ? height : prev));
    };

    const attachObservers = () => {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      measure();
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => measure());
        ro.observe(doc.body);
        if (doc.documentElement) ro.observe(doc.documentElement);
      }
      if (typeof MutationObserver !== "undefined") {
        mo = new MutationObserver(() => measure());
        mo.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }
      doc.querySelectorAll("img").forEach((img) => {
        if (img.complete) return;
        img.addEventListener("load", measure, { once: true });
        img.addEventListener("error", measure, { once: true });
      });
      window.setTimeout(measure, 50);
      window.setTimeout(measure, 250);
    };

    const onLoad = () => attachObservers();
    iframe.addEventListener("load", onLoad);
    if (iframe.contentDocument?.readyState === "complete") {
      attachObservers();
    }

    return () => {
      cancelled = true;
      iframe.removeEventListener("load", onLoad);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div
      className={`taomni-mail-reader-paper ${preferDark ? "is-dark" : ""} ${className ?? ""}`.trim()}
      data-testid="mail-reader-paper"
      data-reader-theme={preferDark ? "dark" : "light"}
    >
      <iframe
        ref={iframeRef}
        title={title}
        data-testid="mail-reader-html"
        className="taomni-mail-reader-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ height: frameHeight }}
      />
    </div>
  );
}

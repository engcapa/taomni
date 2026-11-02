import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { buildMailReaderSrcDoc } from "../../lib/mailHtml";

export interface MailHtmlReaderHandle {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  clearFind: () => void;
}

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
  /** In-app handling of `mailto:` links (opens the composer). */
  onMailtoLink?: (href: string) => void;
}

/**
 * Thunderbird-style HTML mail surface: sandboxed iframe with its own document,
 * base paper chrome, sanitized <style> blocks, and auto height.
 */
export const MailHtmlReader = forwardRef<MailHtmlReaderHandle, MailHtmlReaderProps>(function MailHtmlReader(
  {
    html,
    allowRemoteImages,
    title = "Message body",
    className,
    preferDark = false,
    fontSize = 14,
    fontFamily,
    onMailtoLink,
  },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onMailtoRef = useRef(onMailtoLink);
  onMailtoRef.current = onMailtoLink;
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

  useImperativeHandle(ref, () => ({
    findNext(query: string) {
      return findInFrame(query, false);
    },
    findPrevious(query: string) {
      return findInFrame(query, true);
    },
    clearFind() {
      const win = iframeRef.current?.contentWindow as (Window & {
        getSelection?: () => Selection | null;
      }) | null | undefined;
      try {
        win?.getSelection?.()?.removeAllRanges();
      } catch {
        // ignore
      }
    },
  }), []);

  function findInFrame(query: string, backward: boolean): boolean {
    const trimmed = query.trim();
    if (!trimmed) return false;
    const win = iframeRef.current?.contentWindow as (Window & {
      find?: (
        aString: string,
        aCaseSensitive?: boolean,
        aBackwards?: boolean,
        aWrapAround?: boolean,
        aWholeWord?: boolean,
        aSearchInFrames?: boolean,
        aShowDialog?: boolean,
      ) => boolean;
    }) | null | undefined;
    if (!win?.find) return false;
    try {
      return !!win.find(trimmed, false, backward, true, false, false, false);
    } catch {
      return false;
    }
  }

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let releaseDocument: (() => void) | undefined;

    const attachObservers = () => {
      releaseDocument?.();
      releaseDocument = undefined;
      const doc = iframe.contentDocument;
      const view = doc?.defaultView;
      if (!doc?.body || !view) return;
      let disposed = false;
      let frame: number | undefined;
      const measure = () => {
        frame = undefined;
        if (disposed) return;
        const body = doc.body;
        const root = doc.documentElement;
        if (!body || !root) return;
        const height = Math.ceil(Math.max(
          body.scrollHeight, body.offsetHeight,
          root.scrollHeight, root.offsetHeight, 120,
        ));
        setFrameHeight((prev) => (Math.abs(prev - height) > 1 ? height : prev));
      };
      const schedule = () => {
        if (!disposed && frame === undefined) frame = view.requestAnimationFrame(measure);
      };
      const onFrameClick = (event: MouseEvent) => {
        const anchor = (event.target as Element | null)?.closest?.("a[href]");
        const href = anchor?.getAttribute("href") ?? "";
        if (!/^mailto:/i.test(href) || !onMailtoRef.current) return;
        event.preventDefault();
        onMailtoRef.current(href);
      };
      doc.addEventListener("click", onFrameClick);
      // RO belongs to the observed document. A parent-window observer targeting
      // iframe roots can hit WebView2's cross-document delivery depth checks even
      // without a DOM write. Publish height outside delivery as well.
      const ro = typeof view.ResizeObserver === "undefined" ? null : new view.ResizeObserver(schedule);
      ro?.observe(doc.body);
      ro?.observe(doc.documentElement);
      const mo = typeof view.MutationObserver === "undefined" ? null : new view.MutationObserver(schedule);
      mo?.observe(doc.body, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      const images = [...doc.querySelectorAll("img")].filter((img) => !img.complete);
      for (const img of images) {
        img.addEventListener("load", schedule, { once: true });
        img.addEventListener("error", schedule, { once: true });
      }
      const timers = [view.setTimeout(schedule, 50), view.setTimeout(schedule, 250)];
      schedule();
      releaseDocument = () => {
        disposed = true;
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        for (const timer of timers) view.clearTimeout(timer);
        ro?.disconnect();
        mo?.disconnect();
        doc.removeEventListener("click", onFrameClick);
        for (const img of images) {
          img.removeEventListener("load", schedule);
          img.removeEventListener("error", schedule);
        }
      };
    };

    iframe.addEventListener("load", attachObservers);
    if (iframe.contentDocument?.readyState === "complete") attachObservers();
    return () => {
      iframe.removeEventListener("load", attachObservers);
      releaseDocument?.();
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
});

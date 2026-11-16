interface SettingsSectionRevealOptions {
  resolveAnchor: () => HTMLElement | undefined;
  onReveal: () => void;
  maintainLayout: boolean;
}

/** Keep a deep link visible while preceding asynchronous sections load. */
export function revealSettingsSection({ resolveAnchor, onReveal, maintainLayout }: SettingsSectionRevealOptions) {
  let disposed = false;
  let revealed = false;
  let attempts = 0;
  let frame = 0;
  let observer: ResizeObserver | undefined;
  const inputEvents = ["wheel", "pointerdown", "touchstart", "keydown"] as const;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.cancelAnimationFrame(frame);
    observer?.disconnect();
    for (const event of inputEvents) window.removeEventListener(event, dispose, true);
  };
  const schedule = () => {
    if (!disposed && !frame) frame = window.requestAnimationFrame(reveal);
  };
  const reveal = () => {
    frame = 0;
    if (disposed) return;
    const anchor = resolveAnchor();
    if (!anchor || anchor.closest("[hidden]")) {
      if (++attempts < 48) schedule();
      else dispose();
      return;
    }
    const panel = anchor.closest<HTMLElement>('[data-testid="settings-panel"]');
    if (!revealed && maintainLayout && panel && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(panel);
      // An ASR/model list above the target can grow without resizing either
      // the target itself or its viewport. Observe the whole content owner.
      if (panel.firstElementChild) observer.observe(panel.firstElementChild);
    }
    if (revealed) {
      // A retained Settings tab can be hidden while another view is active.
      if (!panel?.clientHeight) return;
      const margin = Number.parseFloat(window.getComputedStyle(anchor).scrollMarginTop) || 0;
      if (Math.abs(anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - margin) < 1) return;
    }
    anchor.scrollIntoView({ block: "start", behavior: "auto" });
    if (!revealed) {
      revealed = true;
      onReveal();
      // A preset row owns its more specific navigation after this first jump.
      if (!observer) dispose();
    }
  };

  // User input takes over immediately; delayed content must never pull a
  // reader back after they scroll, type, click, or navigate elsewhere.
  for (const event of inputEvents) window.addEventListener(event, dispose, { capture: true, passive: true });
  schedule();
  return dispose;
}

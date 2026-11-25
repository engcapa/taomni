/** Install once per desktop WebView. Module renderers can opt in through a
 * data attribute without importing React or the core application. */
export function installTooltips(doc: Document) {
  const win = doc.defaultView!;
  const tip = doc.createElement("div");
  tip.id = "taomni-control-tooltip";
  tip.className = "taomni-control-tooltip";
  tip.setAttribute("role", "tooltip");
  let owner: HTMLElement | null = null;
  let timer = 0;

  const control = (node: EventTarget | null) =>
    node instanceof Element ? node.closest<HTMLElement>("[data-taomni-tooltip]") : null;

  const close = () => {
    win.clearTimeout(timer);
    if (owner && tip.isConnected) {
      const ids = (owner.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== tip.id);
      if (ids.length) owner.setAttribute("aria-describedby", ids.join(" "));
      else owner.removeAttribute("aria-describedby");
    }
    tip.remove();
    observer.disconnect();
    owner = null;
  };

  const position = () => {
    if (!owner?.isConnected || !owner.getClientRects().length) return close();
    const box = owner.getBoundingClientRect();
    const left = Math.min(box.left, win.innerWidth - tip.offsetWidth - 6);
    const below = box.bottom + 5;
    const top = below + tip.offsetHeight <= win.innerHeight - 6 ? below : box.top - tip.offsetHeight - 5;
    tip.style.left = Math.max(6, left) + "px";
    tip.style.top = Math.max(6, top) + "px";
  };
  const observer = new MutationObserver(() => {
    if (!owner?.isConnected || !owner.dataset.taomniTooltip) return close();
    if (tip.textContent !== owner.dataset.taomniTooltip) {
      tip.textContent = owner.dataset.taomniTooltip;
      position();
    }
  });

  const open = (target: HTMLElement, immediate: boolean) => {
    if (target === owner) return;
    close();
    owner = target;
    const show = () => {
      if (!target.isConnected || !target.dataset.taomniTooltip) return close();
      tip.textContent = target.dataset.taomniTooltip;
      (target.closest("dialog[open]") ?? doc.body).append(tip);
      const ids = [target.getAttribute("aria-describedby"), tip.id].filter(Boolean);
      target.setAttribute("aria-describedby", ids.join(" "));
      position();
      if (owner) {
        observer.observe(target, { attributes: true, attributeFilter: ["data-taomni-tooltip"] });
        observer.observe(doc.body, { childList: true, subtree: true });
      }
    };
    if (immediate) show();
    else timer = win.setTimeout(show, 500);
  };

  const over = (event: PointerEvent) => {
    const target = control(event.target);
    if (target && event.pointerType !== "touch") open(target, tip.isConnected);
  };
  const out = (event: PointerEvent) => {
    if (control(event.target) !== owner) return;
    const next = control(event.relatedTarget);
    if (next && tip.isConnected) open(next, true);
    else if (next !== owner) close();
  };
  const focus = (event: FocusEvent) => {
    const target = control(event.target);
    if (target?.matches(":focus-visible")) open(target, true);
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isComposing && event.key === "Escape") close();
  };
  const events = new AbortController();
  const options = { capture: true, signal: events.signal };
  doc.addEventListener("pointerover", over, options);
  doc.addEventListener("pointerout", out, options);
  doc.addEventListener("focusin", focus, options);
  doc.addEventListener("focusout", close, options);
  doc.addEventListener("pointerdown", close, options);
  doc.addEventListener("keydown", key, options);
  doc.addEventListener("scroll", close, options);
  win.addEventListener("resize", close, options);
  win.addEventListener("blur", close, options);
  return () => { events.abort(); close(); };
}

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailHtmlReader } from "./MailHtmlReader";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const parentObserver = vi.fn(function () {
    return { observe: vi.fn(), disconnect: vi.fn() };
  });
  vi.stubGlobal("ResizeObserver", parentObserver);
  const onMailto = vi.fn();
  const result = render(<MailHtmlReader html="Short body" allowRemoteImages={false} onMailtoLink={onMailto} />);
  const iframe = screen.getByTestId("mail-reader-html") as HTMLIFrameElement;
  const doc = iframe.contentDocument!;
  const view = doc.defaultView!;
  const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  Object.defineProperty(view, "ResizeObserver", { configurable: true, value: class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
  } });
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(view, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(view, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const flush = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
  fireEvent.load(iframe);
  flush();
  return { ...result, iframe, doc, view, observers, parentObserver, frames, flush, onMailto };
}

describe("mail iframe sizing ownership", () => {
  it("observes the body from its own window and publishes resize height outside observer delivery", () => {
    const h = setup();
    expect(h.parentObserver).not.toHaveBeenCalled();
    expect(h.observers).toHaveLength(1);
    const previousHeight = h.iframe.style.height;
    Object.defineProperty(h.doc.body, "scrollHeight", { configurable: true, value: 320 });
    act(() => { h.observers[0].notify(); h.observers[0].notify(); });
    expect(h.iframe.style.height).toBe(previousHeight);
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.iframe.style.height).toBe("320px");
  });

  it("releases the prior document owner on load and cancels queued sizing on unmount", () => {
    const h = setup();
    const first = h.observers[0];
    fireEvent.load(h.iframe);
    expect(first.disconnect).toHaveBeenCalledOnce();
    h.flush();
    act(() => h.observers[1].notify());
    expect(h.frames.size).toBe(1);
    h.unmount();
    expect(h.observers[1].disconnect).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
    act(() => { first.notify(); h.observers[1].notify(); });
    expect(h.frames.size).toBe(0);
  });

  it("keeps a single mailto listener through reloads and removes it on unmount", () => {
    const h = setup();
    fireEvent.load(h.iframe);
    const link = h.doc.createElement("a");
    link.href = "mailto:zed.contact@example.org";
    h.doc.body.append(link);
    const click = () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click()).toBe(false);
    expect(h.onMailto).toHaveBeenCalledExactlyOnceWith("mailto:zed.contact@example.org");
    h.unmount();
    click();
    expect(h.onMailto).toHaveBeenCalledOnce();
  });
});

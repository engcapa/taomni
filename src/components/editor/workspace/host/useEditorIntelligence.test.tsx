import { act, cleanup, renderHook } from "@testing-library/react";
import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageForPath } from "../../../git/diffLanguage";
import { useEditorIntelligence } from "./useEditorIntelligence";

vi.mock("../../../git/diffLanguage", () => ({ languageForPath: vi.fn() }));

describe("editor language activation", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  beforeEach(() => {
    vi.mocked(languageForPath).mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback); return sequence;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => { cleanup(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const renderLanguage = () => {
    let current: Extension = [];
    let languageCompartment: Compartment | undefined;
    vi.spyOn(Compartment.prototype, "get").mockImplementation(function (this: Compartment) {
      return !languageCompartment || this === languageCompartment ? current : [];
    });
    const view = { dispatch: vi.fn(), state: {} } as unknown as EditorView;
    const viewRef = { current: view };
    const rendered = renderHook(({ fileKey, path }) => useEditorIntelligence({
      fileKey, path, viewRef, showHoverDocumentation: false, hoverDocumentationDelayMs: 500,
      onHoverRef: { current: async () => null }, onPinHoverDocRef: { current: undefined },
      parameterInfoRequestNonce: 0, parameterPopup: null, parameterInfoShowFullSignaturesRef: { current: false },
    }), { initialProps: { fileKey: "a", path: "a.json" } });
    languageCompartment = rendered.result.current.languageCompartment.current;
    return { ...rendered, view, setLanguage: (extension: Extension) => { current = extension; } };
  };
  const paint = () => act(() => {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(1));
  });

  it("yields language installation until the document's first measurement frame", async () => {
    const language: Extension = [];
    vi.mocked(languageForPath).mockResolvedValue(language);
    const { view } = renderLanguage();
    await act(async () => {});
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    paint();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    paint();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("cancels a resolved language when a different file owns the retained view", async () => {
    vi.mocked(languageForPath).mockResolvedValueOnce([]).mockResolvedValueOnce(null);
    const { view, rerender } = renderLanguage();
    await act(async () => {});
    expect(frames.size).toBe(1);
    rerender({ fileKey: "b", path: "b.txt" });
    await act(async () => {});
    paint();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("rejects late language results and cancels pending work on unmount", async () => {
    let reply!: (extension: Extension) => void;
    vi.mocked(languageForPath).mockReturnValueOnce(new Promise((resolve) => { reply = resolve; })).mockResolvedValueOnce([]);
    const { view, rerender, unmount } = renderLanguage();
    rerender({ fileKey: "b", path: "b.ts" });
    await act(async () => { reply([]); });
    expect(frames.size).toBe(1);
    unmount();
    paint();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("keeps a cached language and clears an old grammar after a load failure", async () => {
    const cached: Extension = [];
    let reply!: (extension: Extension) => void;
    vi.mocked(languageForPath).mockReturnValueOnce(new Promise((resolve) => { reply = resolve; })).mockRejectedValueOnce(new Error("load failed"));
    const { view, rerender, setLanguage } = renderLanguage();
    setLanguage(cached);
    await act(async () => { reply(cached); });
    expect(frames.size).toBe(0);
    setLanguage(new Compartment().of([]));
    rerender({ fileKey: "b", path: "b.ts" });
    await act(async () => {});
    paint();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });
});

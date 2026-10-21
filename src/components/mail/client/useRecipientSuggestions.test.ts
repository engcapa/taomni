import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailIndexCachedContacts, mailSearchContacts, type MailContactSuggestion } from "../../../lib/mail";
import type { MailTabInfo } from "../../../types";
import { EMPTY_DRAFT } from "./compose";
import { useRecipientSuggestions } from "./useRecipientSuggestions";

vi.mock("../../../lib/mail", () => ({
  mailIndexCachedContacts: vi.fn(async () => 0),
  mailSearchContacts: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const info = { sessionId: "account-a" } as MailTabInfo;
const context = { info, composeOpen: true, draft: EMPTY_DRAFT, messages: [] };
const alice: MailContactSuggestion = { email: "alice@example.test", name: "Alice", source: "history", score: 100 };
const bob: MailContactSuggestion = { email: "bob@example.test", name: "Bob", source: "history", score: 100 };

describe("recipient suggestions request ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the current query when an older search finishes last", async () => {
    const first = deferred<MailContactSuggestion[]>();
    const second = deferred<MailContactSuggestion[]>();
    vi.mocked(mailSearchContacts).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useRecipientSuggestions(context));
    act(() => result.current.handleRecipientQueryChange("to", "ali"));
    await act(() => vi.advanceTimersByTimeAsync(120));
    act(() => result.current.handleRecipientQueryChange("to", "bob"));
    await act(() => vi.advanceTimersByTimeAsync(120));
    await act(async () => second.resolve([bob]));
    await act(async () => first.resolve([alice]));
    expect(result.current.recipientSuggestionsFor("to")).toEqual([bob]);
    expect(result.current.recipientSuggestionsFor("cc")).toEqual([]);
  });

  it("invalidates an in-flight search when the composer closes", async () => {
    const search = deferred<MailContactSuggestion[]>();
    vi.mocked(mailSearchContacts).mockReturnValueOnce(search.promise);
    const { result, rerender } = renderHook(
      ({ composeOpen }) => useRecipientSuggestions({ ...context, composeOpen }),
      { initialProps: { composeOpen: true } },
    );
    act(() => result.current.handleRecipientQueryChange("to", "ali"));
    await act(() => vi.advanceTimersByTimeAsync(120));
    rerender({ composeOpen: false });
    await act(async () => search.resolve([alice]));
    expect(result.current.recipientSearch.suggestions).toEqual([]);
    expect(result.current.recipientSearch.loading).toBe(false);
  });

  it("indexes once per account and does not reuse results across accounts", async () => {
    const first = deferred<MailContactSuggestion[]>();
    const second = deferred<MailContactSuggestion[]>();
    vi.mocked(mailSearchContacts).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ info }) => useRecipientSuggestions({ ...context, info }),
      { initialProps: { info } },
    );
    act(() => result.current.handleRecipientQueryChange("to", "ali"));
    await act(() => vi.advanceTimersByTimeAsync(120));
    rerender({ info: { ...info, sessionId: "account-b" } });
    await act(() => vi.advanceTimersByTimeAsync(120));
    await act(async () => first.resolve([alice]));
    expect(result.current.recipientSearch.suggestions).toEqual([]);
    await act(async () => second.resolve([bob]));
    expect(result.current.recipientSearch.suggestions).toEqual([bob]);
    expect(mailIndexCachedContacts).toHaveBeenNthCalledWith(1, "account-a");
    expect(mailIndexCachedContacts).toHaveBeenNthCalledWith(2, "account-b");
    expect(mailIndexCachedContacts).toHaveBeenCalledTimes(2);
  });
});

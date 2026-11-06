import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairForm } from "./PairForm";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rejected: [string, () => unknown][] = [
  ["HTML gateway login", () => { throw new SyntaxError("HTML instead of JSON"); }],
  ["empty JSON", () => ({})],
  ["missing token", () => ({ device_id: "phone" })],
  ["wrong token type", () => ({ device_id: "phone", token: 7 })],
  ["empty device ID", () => ({ device_id: "", token: "secret" })],
  ["null response", () => null],
];
it.each(rejected)("does not save or navigate on %s from the gateway", async (_label, json) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json() }));
  const paired = vi.fn();
  render(<PairForm onPair={paired} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByTestId("mobile-pair-code"), { target: { value: "qa-code" } });
  fireEvent.click(screen.getByTestId("mobile-pair-submit"));
  expect(await screen.findByTestId("mobile-pair-error")).toHaveTextContent("有效的 Taomni API");
  expect(paired).not.toHaveBeenCalled();
  expect(screen.getByTestId("mobile-pair-submit")).toBeEnabled();
  expect(screen.getByTestId("mobile-pair-code")).toHaveValue("qa-code");
});

it("uses actual device credentials after a valid same-origin response", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ device_id: "phone", token: "qa-token" }) });
  vi.stubGlobal("fetch", fetch);
  const paired = vi.fn();
  render(<PairForm onPair={paired} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByTestId("mobile-pair-code"), { target: { value: "qa-code" } });
  fireEvent.click(screen.getByTestId("mobile-pair-submit"));
  await waitFor(() => expect(paired).toHaveBeenCalledWith(expect.objectContaining({
    id: `${location.origin}:phone`, deviceId: "phone", token: "qa-token", endpoint: location.origin,
  })));
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "manual" });
});

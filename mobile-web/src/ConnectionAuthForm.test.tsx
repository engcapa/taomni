import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionAuthForm } from "./ConnectionAuthForm";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("masks secrets, answers the exact round once, clears fields and never writes credentials to storage", async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const cancel = vi.fn();
  render(<ConnectionAuthForm instance={{ endpoint: "https://pc.example", token: "t" } as never} requestId="open/1" challenge={{ id: "round-2", name: "SSH", instructions: "", prompts: [{ prompt: "用户名", echo: true, initial: "root" }, { prompt: "OTP", echo: false, initial: "must-not-show" }] }} onCancel={cancel} />);
  const secret = screen.getByTestId("mobile-auth-answer-1");
  expect(secret).toHaveAttribute("type", "password"); expect(secret).toHaveValue("");
  fireEvent.change(secret, { target: { value: "123456" } });
  fireEvent.click(screen.getByTestId("mobile-auth-submit"));
  await waitFor(() => expect(screen.getByTestId("mobile-auth-submit")).toHaveTextContent("等待连接"));
  expect(secret).toHaveValue("");
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://pc.example/api/v1/open-requests/open%2F1/auth");
  expect(JSON.parse(String(options.body))).toEqual({ challenge_id: "round-2", responses: ["root", "123456"] });
  fireEvent.click(screen.getByTestId("mobile-auth-submit"));
  expect(fetch).toHaveBeenCalledOnce(); expect(storage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("mobile-auth-cancel")); expect(cancel).toHaveBeenCalledOnce();
  storage.mockRestore();
});

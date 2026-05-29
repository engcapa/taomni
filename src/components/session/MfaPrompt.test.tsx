import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshAuthPromptPayload } from "../../lib/ipc";
import { MfaPrompt } from "./MfaPrompt";

afterEach(cleanup);

function makeRequest(overrides: Partial<SshAuthPromptPayload> = {}): SshAuthPromptPayload {
  return {
    requestId: "sess-1:abc",
    name: "Two-Step Verification",
    instructions: "Two-Step Verification required",
    prompts: [{ prompt: "Please Input Mfa Code (AliyunOTP):", echo: false }],
    ...overrides,
  };
}

describe("MfaPrompt", () => {
  it("renders server instructions and prompt label", () => {
    render(
      <MfaPrompt
        host="bastion.example.com"
        username="alice"
        request={makeRequest()}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("mfa-instructions")).toHaveTextContent(
      "Two-Step Verification required",
    );
    expect(screen.getByText("Please Input Mfa Code (AliyunOTP):")).toBeInTheDocument();
  });

  it("masks the input when the prompt is non-echo", () => {
    render(
      <MfaPrompt
        host="h"
        username="u"
        request={makeRequest()}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("mfa-answer-0")).toHaveAttribute("type", "password");
  });

  it("uses a text input when the prompt echoes", () => {
    render(
      <MfaPrompt
        host="h"
        username="u"
        request={makeRequest({ prompts: [{ prompt: "Username:", echo: true }] })}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("mfa-answer-0")).toHaveAttribute("type", "text");
  });

  it("submits one answer per prompt in order", async () => {
    const onSubmit = vi.fn();
    render(
      <MfaPrompt
        host="h"
        username="u"
        request={makeRequest({
          prompts: [
            { prompt: "Code 1:", echo: false },
            { prompt: "Code 2:", echo: false },
          ],
        })}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await userEvent.type(screen.getByTestId("mfa-answer-0"), "111111");
    await userEvent.type(screen.getByTestId("mfa-answer-1"), "222222");
    await userEvent.click(screen.getByTestId("mfa-submit"));
    expect(onSubmit).toHaveBeenCalledWith(["111111", "222222"]);
  });

  it("cancels via the cancel button", async () => {
    const onCancel = vi.fn();
    render(
      <MfaPrompt
        host="h"
        username="u"
        request={makeRequest()}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByTestId("mfa-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

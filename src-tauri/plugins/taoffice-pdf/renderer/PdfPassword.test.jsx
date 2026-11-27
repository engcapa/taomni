import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let PdfPassword;
beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ PdfPassword } = await import("./PdfPassword.jsx"));
  vi.unstubAllGlobals();
});
afterEach(cleanup);
const label = (_zh, en) => en;

describe("PDF password challenge", () => {
  it("submits a masked value and clears it before a retry", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const submit = vi.fn();
    const { rerender } = render(<PdfPassword active challenge={{ submit, incorrect: false }}
      label={label} onSubmit={onSubmit} onCancel={onCancel} />);
    const input = screen.getByLabelText("Document password");
    const unlock = screen.getByRole("button", { name: "Unlock" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("type", "password");
    expect(unlock).toBeDisabled();
    fireEvent.change(input, { target: { value: "first try" } });
    fireEvent.submit(screen.getByRole("form", { name: "Unlock PDF" }));
    expect(onSubmit).toHaveBeenCalledWith("first try");
    expect(input).toHaveValue("");
    rerender(<PdfPassword active challenge={{ submit, incorrect: true }}
      label={label} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

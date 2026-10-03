import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SocksCapRootPrompt } from "./SocksCapRootPrompt";

describe("SocksCapRootPrompt", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title, subtitle, and input field", () => {
    render(<SocksCapRootPrompt onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("sockscap-root-prompt-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("sockscap-root-password-input")).toBeInTheDocument();
    expect(screen.getByTestId("sockscap-root-prompt-submit")).toBeDisabled();
  });

  it("enables confirm button when password entered and calls onSubmit", () => {
    const handleSubmit = vi.fn();
    render(<SocksCapRootPrompt onSubmit={handleSubmit} onCancel={vi.fn()} />);

    const input = screen.getByTestId("sockscap-root-password-input");
    fireEvent.change(input, { target: { value: "secret123" } });

    const submitBtn = screen.getByTestId("sockscap-root-prompt-submit");
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);
    expect(handleSubmit).toHaveBeenCalledWith("secret123");
  });

  it("calls onCancel when cancel or close button is clicked", () => {
    const handleCancel = vi.fn();
    render(<SocksCapRootPrompt onSubmit={vi.fn()} onCancel={handleCancel} />);

    fireEvent.click(screen.getByTestId("sockscap-root-prompt-cancel"));
    expect(handleCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("sockscap-root-prompt-close"));
    expect(handleCancel).toHaveBeenCalledTimes(2);
  });

  it("displays error message when error prop is provided", () => {
    render(
      <SocksCapRootPrompt
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        error="Sudo password incorrect"
      />
    );

    expect(screen.getByTestId("sockscap-root-prompt-error")).toHaveTextContent(
      "Sudo password incorrect"
    );
  });
});
